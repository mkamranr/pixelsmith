import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { isPixelsmithError } from '@pixelsmith/contracts'
import { deriveName, probeImage } from '@pixelsmith/core'
import type { AppContext } from '../context.js'
import { BadRequestError, NotFoundError, TooManyFilesError } from '../errors.js'
import { coerceFormParams } from '../params.js'
import { pageData } from '../render.js'

/** Where a failed form send the user back to, with a readable reason. */
const back = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`

export async function registerPages(app: FastifyInstance, ctx: AppContext) {
  app.get('/', async (req, reply) => reply.view('home.njk', pageData(ctx, req, reply)))

  app.get('/login', async (req, reply) => {
    if (req.currentUser) return reply.redirect('/')
    const q = req.query as { error?: string; next?: string }
    return reply.view('login.njk', pageData(ctx, req, reply, { error: q.error, next: q.next ?? '/' }))
  })

  app.post('/login', { preHandler: app.csrfProtection }, async (req, reply) => {
    const body = req.body as { email?: string; password?: string; next?: string }
    const next = body.next && body.next.startsWith('/') ? body.next : '/'

    try {
      const user = await ctx.users.authenticate(body.email ?? '', body.password ?? '')
      const { token } = await ctx.sessions.createSession(user.id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        ttlMs: ctx.config.sessionTtlMs,
      })
      await ctx.audit.record({ userId: user.id, action: 'login', ip: req.ip })

      reply.setCookie('pixelsmith_session', token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        signed: true,
        secure: ctx.config.isProduction,
        maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
      })
      return reply.redirect(next)
    } catch (err) {
      await ctx.audit.record({ action: 'login_failed', subject: body.email ?? null, ip: req.ip })
      const message = err instanceof Error ? err.message : 'Sign in failed'
      return reply.redirect(back('/login', message))
    }
  })

  app.post('/logout', { preHandler: [app.requireUser, app.csrfProtection] }, async (req, reply) => {
    if (req.sessionToken) await ctx.sessions.destroySession(req.sessionToken)
    await ctx.audit.record({ userId: req.currentUser!.id, action: 'logout', ip: req.ip })
    reply.clearCookie('pixelsmith_session', { path: '/' })
    return reply.redirect('/')
  })

  app.get('/tools/:toolId', async (req, reply) => {
    const { toolId } = req.params as { toolId: string }
    if (!ctx.registry.has(toolId)) throw new NotFoundError('Tool')
    const tool = ctx.registry.get(toolId)
    const q = req.query as { error?: string }
    // A tool can ask for its own interactive page rather than the generic form.
    const template = tool.ui.surface === 'editor' ? 'editor.njk' : 'tool.njk'
    return reply.view(template, pageData(ctx, req, reply, { tool, error: q.error }))
  })

  /**
   * Upload and enqueue.
   *
   * Files are streamed to disk under a job id generated up front, before the
   * database row exists. A crash in between leaves an orphan directory, which
   * the sweeper reclaims — the alternative, buffering entire uploads in memory
   * to keep the write atomic, is how you run a server out of RAM.
   */
  app.post('/tools/:toolId', { preHandler: app.requireUser }, async (req, reply) => {
    const { toolId } = req.params as { toolId: string }
    if (!ctx.registry.has(toolId)) throw new NotFoundError('Tool')
    const tool = ctx.registry.get(toolId)

    const maxMb = Math.round(ctx.config.MAX_UPLOAD_BYTES / (1024 * 1024))
    const jobId = randomUUID()
    const fields: Record<string, unknown> = {}
    const staged: { name: string; relPath: string }[] = []

    /**
     * Validate CSRF from the streamed fields.
     *
     * The token is the first field in the form, so this runs before a single
     * byte of file data is written — a forged request must not be able to make
     * us spend disk on it. The shared hook is reused rather than reimplemented,
     * so there is still only one CSRF implementation on the server.
     */
    let csrfChecked = false
    const ensureCsrf = async () => {
      if (csrfChecked) return
      ;(req as { body?: unknown }).body = fields
      await new Promise<void>((resolve, reject) => {
        app.csrfProtection(req, reply, (err?: unknown) =>
          err ? reject(err as Error) : resolve(),
        )
      })
      csrfChecked = true
    }

    // Directories are created lazily, only once the request has proved itself.
    // A forged or malformed upload then leaves nothing at all behind.
    let paths: { dir: string; inDir: string } | undefined
    const ensurePaths = async () => {
      paths ??= await ctx.storage.prepare(jobId)
      return paths
    }

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = part.value
          continue
        }
        await ensureCsrf()
        if (staged.length >= ctx.config.MAX_FILES_PER_JOB) {
          throw new TooManyFilesError(ctx.config.MAX_FILES_PER_JOB)
        }
        const { inDir } = await ensurePaths()
        // deriveName strips any directory component the browser may have sent.
        const safeName = deriveName(part.filename || 'upload.bin')
        const target = join(inDir, `${staged.length}-${safeName}`)
        await pipeline(part.file, createWriteStream(target))
        if (part.file.truncated) {
          throw new BadRequestError(`${safeName} is larger than the ${maxMb} MB per-file limit`)
        }
        staged.push({ name: safeName, relPath: `in/${staged.length}-${safeName}` })
      }

      // A generator tool takes no uploads, so the CSRF check would otherwise
      // never run — there is no first file part to trigger it.
      await ensureCsrf()

      if (tool.inputMode !== 'none' && staged.length === 0) {
        throw new BadRequestError('Choose at least one image')
      }

      // Probe every upload before a job exists: reject bad input at the door
      // rather than discovering it in a worker.
      const { dir } = await ensurePaths()
      const inputs = []
      for (const file of staged) {
        const probe = await probeImage(join(dir, file.relPath))
        inputs.push({
          role: 'input' as const,
          name: file.name,
          relPath: file.relPath,
          mime: probe.mime,
          bytes: probe.bytes,
        })
      }

      const params = ctx.registry.parseParams(toolId, coerceFormParams(tool, fields))

      const job = await ctx.jobs.createJob({ id: jobId, userId: req.currentUser!.id, toolId, params })
      await ctx.jobs.addFiles(job.id, inputs)
      await ctx.audit.record({
        userId: req.currentUser!.id,
        action: 'job_created',
        subject: job.id,
        detail: { tool: toolId, files: inputs.length },
        ip: req.ip,
      })
      await ctx.queue.enqueue(job.id, tool.queue)

      return reply.redirect(`/jobs/${job.id}`)
    } catch (err) {
      await ctx.storage.remove(jobId).catch(() => {})
      // Problems the user can act on go back to the form with an explanation.
      // Anything else (a rejected CSRF token, an unexpected fault) becomes a
      // real status code rather than a friendly redirect.
      if (isPixelsmithError(err)) {
        return reply.redirect(back(`/tools/${toolId}`, err.message))
      }
      throw err
    }
  })

  app.get('/api/docs', async (req, reply) => reply.view('api-docs.njk', pageData(ctx, req, reply)))

  app.get('/jobs', { preHandler: app.requireUser }, async (req, reply) => {
    const jobs = await ctx.jobs.listJobsForUser(req.currentUser!.id, 50)
    return reply.view('jobs.njk', pageData(ctx, req, reply, { jobs }))
  })

  app.get('/jobs/:id', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await ctx.jobs.getJobForUser(id, req.currentUser!.id)
    if (!job) throw new NotFoundError('Job')

    const files = await ctx.jobs.listFiles(job.id)
    const tool = ctx.registry.has(job.toolId) ? ctx.registry.get(job.toolId) : null
    return reply.view('job.njk', pageData(ctx, req, reply, {
      job,
      tool,
      inputs: files.filter((f) => f.role === 'input'),
      outputs: files.filter((f) => f.role === 'output'),
      isFinished: ['done', 'failed', 'expired', 'cancelled'].includes(job.status),
    }))
  })

  app.get('/account', { preHandler: app.requireUser }, async (req, reply) => {
    const q = req.query as { error?: string; ok?: string }
    return reply.view('account.njk', pageData(ctx, req, reply, { error: q.error, ok: q.ok }))
  })

  app.post('/account/password', { preHandler: [app.requireUser, app.csrfProtection] }, async (req, reply) => {
    const body = req.body as { current?: string; next?: string; confirm?: string }
    try {
      if (body.next !== body.confirm) throw new BadRequestError('The new passwords do not match')
      await ctx.users.authenticate(req.currentUser!.email, body.current ?? '')
      await ctx.users.changePassword(req.currentUser!.id, body.next ?? '')
      // Other sessions must not survive a password change.
      await ctx.sessions.destroyAllForUser(req.currentUser!.id)
      await ctx.audit.record({ userId: req.currentUser!.id, action: 'password_changed', ip: req.ip })
      return reply.redirect('/login?error=' + encodeURIComponent('Password changed. Please sign in again.'))
    } catch (err) {
      return reply.redirect(back('/account', err instanceof Error ? err.message : 'Could not change password'))
    }
  })
}
