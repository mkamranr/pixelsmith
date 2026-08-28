import { readFile } from 'node:fs/promises'

import type { FastifyInstance } from 'fastify'
import { isPixelsmithError } from '@pixelsmith/contracts'
import { acceptAttribute, describeAccepts } from '@pixelsmith/core'
import type { JobFile } from '@pixelsmith/db'
import type { AppContext } from '../context.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { intakeJob } from '../intake.js'
import { pageData } from '../render.js'
import { jobFor } from '../job-access.js'

/** Tool groups whose whole purpose is the size of the file. */
const SIZE_IS_THE_POINT = new Set(['optimize', 'pdf-optimize'])

/** Enough of a text result to read on the page without loading a whole book. */
const TEXT_PREVIEW_LIMIT = 20_000

/**
 * What the page needs to know about one result: whether it can be shown as a
 * picture, and if it is text, the text itself. A summary handed over as a file
 * to open elsewhere is the job left half done — the point of asking for one is
 * to read it.
 */
async function describeOutput(ctx: AppContext, jobId: string, file: JobFile) {
  const kind = file.mime.startsWith('image/')
    ? 'image'
    : file.mime === 'application/pdf'
      ? 'document'
      : file.mime.startsWith('text/')
        ? 'text'
        : 'file'

  let text: string | null = null
  let truncated = false
  if (kind === 'text' && file.bytes > 0) {
    try {
      const path = await ctx.storage.readable(jobId, file.relPath)
      const raw = await readFile(path, 'utf8')
      truncated = raw.length > TEXT_PREVIEW_LIMIT
      text = truncated ? raw.slice(0, TEXT_PREVIEW_LIMIT) : raw
    } catch {
      // Swept, or unreadable. The download link still speaks for itself, and a
      // results page that fails because a preview could not be read would be a
      // worse outcome than a results page without the preview.
      text = null
    }
  }

  return { ...file, kind, text, truncated }
}

/** Where a failed form send the user back to, with a readable reason. */
const back = (path: string, message: string) => `${path}?error=${encodeURIComponent(message)}`

export async function registerPages(app: FastifyInstance, ctx: AppContext) {
  app.get('/', async (req, reply) => reply.view('home.njk', pageData(ctx, req, reply)))

  app.get('/tools/:toolId', async (req, reply) => {
    const { toolId } = req.params as { toolId: string }
    if (!ctx.registry.has(toolId)) throw new NotFoundError('Tool')
    const base = ctx.registry.get(toolId)
    // Decorated for the template: the picker's accept list and a description of
    // it in words, both derived from the tool's own declared types.
    const tool = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      acceptAttribute: acceptAttribute(base),
      acceptsDescription: describeAccepts(base),
      /** A card per document rather than a grid of one document's pages. */
      pdfFileView: base.family === 'pdf' && base.ui.pdfView === 'files',
      /** Whether the from/to range rows have a field to write into. */
      hasRangeField: base.ui.fields.some((field) => field.name === 'ranges'),
      /** Areas drawn on the picture itself, for tools that ask for them. */
      imageBoxes: base.family === 'image' && base.ui.imageEdit === 'boxes',
    })
    const q = req.query as { error?: string; from?: string }

    /**
     * Chaining: the outputs of a finished job become the inputs here, with no
     * re-upload. Ownership is checked before anything is revealed — a job id in
     * a URL must not disclose another user's filenames.
     */
    let sourceJob = null
    let sourceFiles: { id: string; name: string; bytes: number; mime: string }[] = []
    if (q.from) {
      const source = await jobFor(ctx, req, q.from)
      if (!source) throw new NotFoundError('Job')
      sourceJob = source
      if (source.status === 'done') {
        sourceFiles = (await ctx.jobs.listFiles(source.id))
          .filter((f) => f.role === 'output')
          .map((f) => ({ id: f.id, name: f.name, bytes: f.bytes, mime: f.mime }))
      }
    }

    // A tool can ask for its own interactive page rather than the generic form.
    const SURFACES: Record<string, string> = {
      editor: 'editor.njk',
      crop: 'crop.njk',
      htmlshot: 'htmlshot.njk',
      canvas: 'canvas.njk',
      pdfedit: 'pdfedit.njk',
      pdforganize: 'pdforganize.njk',
    }
    const template = SURFACES[tool.ui.surface ?? 'form'] ?? 'tool.njk'
    return reply.view(
      template,
      pageData(ctx, req, reply, { tool, error: q.error, sourceJob, sourceFiles }),
    )
  })

  /**
   * Upload and enqueue, from the browser form.
   *
   * The work is in intakeJob, which the API shares: one implementation, so a
   * file accepted here is accepted there and refused here is refused there.
   */
  app.post('/tools/:toolId', { preHandler: app.requireUser }, async (req, reply) => {
    const { toolId } = req.params as { toolId: string }
    if (!ctx.registry.has(toolId)) throw new NotFoundError('Tool')

    try {
      const { jobId } = await intakeJob({ app, ctx, req, reply, toolId, csrf: true })
      return reply.redirect(`/jobs/${jobId}`)
    } catch (err) {
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
    const job = await jobFor(ctx, req, id)
    if (!job) throw new NotFoundError('Job')

    const files = await ctx.jobs.listFiles(job.id)
    const tool = ctx.registry.has(job.toolId) ? ctx.registry.get(job.toolId) : null
    const inputs = files.filter((f) => f.role === 'input')
    const outputs = files.filter((f) => f.role === 'output')

    /**
     * Offer a comparison only where there is something to compare and a way to
     * compare it. A generator tool has no original; and two documents cannot be
     * slid over one another in an <img>, which is what the slider did — two
     * broken images with a percentage between them.
     */
    const isPicture = (f: { mime: string }) => f.mime.startsWith('image/')
    const comparisons =
      outputs.length === inputs.length && outputs.every(isPicture) && inputs.every(isPicture)
        ? outputs.map((out, index) => ({ before: inputs[index]!, after: out }))
        : []

    /**
     * Whether a size difference is worth stating. It is the point of a
     * compressor and noise everywhere else: "0% larger" beside a rotated page
     * reads as a fault, and "84% smaller" beside a summary invites the thought
     * that the document was compressed rather than read.
     */
    const showsSize = tool !== null && SIZE_IS_THE_POINT.has(tool.ui.group)

    return reply.view('job.njk', pageData(ctx, req, reply, {
      job,
      tool,
      inputs,
      outputs: await Promise.all(outputs.map((f) => describeOutput(ctx, job.id, f))),
      comparisons,
      showsSize,
      isFinished: ['done', 'failed', 'expired', 'cancelled'].includes(job.status),
    }))
  })

}

/**
 * Pages that only make sense with accounts enabled: sign in, sign out and
 * change password. In open-access mode they are never registered, so they 404
 * rather than existing as dead ends.
 */
export async function registerAuthPages(app: FastifyInstance, ctx: AppContext) {
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
