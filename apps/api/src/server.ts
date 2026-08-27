import { fileURLToPath } from 'node:url'
import fastifyCookie from '@fastify/cookie'
import fastifyCsrf from '@fastify/csrf-protection'
import fastifyFormbody from '@fastify/formbody'
import fastifyHelmet from '@fastify/helmet'
import fastifyMultipart from '@fastify/multipart'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import fastifyView from '@fastify/view'
import Fastify, { type FastifyInstance } from 'fastify'
import nunjucks from 'nunjucks'
import { isPixelsmithError } from '@pixelsmith/contracts'
import type { AppContext } from './context.js'
import { authPlugin } from './plugins/auth.js'
import { registerAdmin } from './routes/admin.js'
import { registerApi } from './routes/api.js'
import { registerFiles } from './routes/files.js'
import { registerAuthPages, registerPages } from './routes/pages.js'
import { registerPreview } from './routes/preview.js'
import { registerSettings } from './routes/settings.js'
import { pageData } from './render.js'

const VIEWS = fileURLToPath(new URL('./views', import.meta.url))
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.LOG_LEVEL },
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  })

  await app.register(fastifyHelmet, {
    // Every asset is served from this origin. Nothing external is permitted,
    // which is both a security posture and a working air-gap assertion.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })

  await app.register(fastifyCookie, { secret: ctx.config.cookieSecret })
  await app.register(fastifyFormbody)
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieOpts: { signed: true, httpOnly: true, sameSite: 'strict', path: '/' },
  })

  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Login is the endpoint worth brute-forcing; it gets its own tighter budget.
    keyGenerator: (req) => `${req.ip}:${req.url.startsWith('/login') ? 'login' : 'general'}`,
    allowList: () => false,
  })

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: ctx.config.MAX_UPLOAD_BYTES,
      files: ctx.config.MAX_FILES_PER_JOB,
      fields: 40,
      fieldSize: 64 * 1024,
    },
  })

  await app.register(fastifyView, {
    engine: { nunjucks },
    root: VIEWS,
    viewExt: 'njk',
    options: {
      // autoescape is nunjucks' default, but it is the single most important
      // setting on this server, so it is stated rather than assumed.
      autoescape: true,
      noCache: !ctx.config.isProduction,
    },
  })

  await app.register(fastifyStatic, {
    root: PUBLIC,
    prefix: '/static/',
    // Long cache, and filenames stay stable; safe because the whole app ships
    // as one versioned image.
    maxAge: ctx.config.isProduction ? '7d' : 0,
  })

  await app.register(authPlugin, { ctx })

  await registerApi(app, ctx)

  await registerSettings(app, ctx)
  await registerPreview(app, ctx)
  await registerPages(app, ctx)
  await registerFiles(app, ctx)
  // Nothing to sign into, and nothing to administer, without accounts.
  if (!ctx.config.isOpenAccess) {
    await registerAuthPages(app, ctx)
    await registerAdmin(app, ctx)
  }

  /**
   * One place that turns an error into a response. Deliberate errors show their
   * message; anything else is logged in full and shown as a generic failure, so
   * an unexpected stack never reaches a user.
   */
  app.setErrorHandler(async (err, req, reply) => {
    const deliberate = isPixelsmithError(err)
    const status = deliberate ? err.status : (err.statusCode ?? 500)

    if (!deliberate && status >= 500) {
      req.log.error({ err }, 'unhandled error')
    }

    const wantsJson = req.url.startsWith('/api/') || req.headers.accept?.includes('application/json')
    const message = deliberate || status < 500 ? err.message : 'Something went wrong on the server'
    const code = deliberate ? err.code : (err.code ?? 'internal_error')

    if (wantsJson) {
      return reply.status(status).send({ error: { code, message } })
    }

    // An unauthenticated page request should land on the sign-in form, not an
    // error page — with a return path so the user resumes where they were.
    if (status === 401) {
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`)
    }

    return reply.status(status).view('error.njk', pageData(ctx, req, reply, { status, message }))
  })

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint' } })
    }
    return reply.status(404).view('error.njk', pageData(ctx, req, reply, {
      status: 404,
      message: 'That page does not exist',
    }))
  })

  return app
}
