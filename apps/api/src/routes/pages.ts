import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, rm, stat } from 'node:fs/promises'
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
    const q = req.query as { error?: string; from?: string }

    /**
     * Chaining: the outputs of a finished job become the inputs here, with no
     * re-upload. Ownership is checked before anything is revealed — a job id in
     * a URL must not disclose another user's filenames.
     */
    let sourceJob = null
    let sourceFiles: { id: string; name: string; bytes: number; mime: string }[] = []
    if (q.from) {
      const source = await ctx.jobs.getJobForUser(q.from, req.currentUser!.id)
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
    }
    const template = SURFACES[tool.ui.surface ?? 'form'] ?? 'tool.njk'
    return reply.view(
      template,
      pageData(ctx, req, reply, { tool, error: q.error, sourceJob, sourceFiles }),
    )
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
     * Supporting files, keyed by the form field that carried them (a watermark
     * logo, say). Uploaded the same way as inputs but never processed as one,
     * so they must be told apart here rather than downstream.
     */
    const stagedAssets: { name: string; relPath: string }[] = []

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

        const isAsset = part.fieldname !== 'files'
        if (!isAsset && staged.length >= ctx.config.MAX_FILES_PER_JOB) {
          throw new TooManyFilesError(ctx.config.MAX_FILES_PER_JOB)
        }
        if (isAsset && stagedAssets.length >= 4) {
          throw new BadRequestError('Too many supporting files')
        }

        const { inDir } = await ensurePaths()
        // deriveName strips any directory component the browser may have sent.
        const safeName = deriveName(part.filename || 'upload.bin')
        const stagedName = isAsset
          ? `asset-${deriveName(part.fieldname, { ext: 'bin' }).replace(/\.bin$/, '')}-${safeName}`
          : `${staged.length}-${safeName}`

        const target = join(inDir, stagedName)
        await pipeline(part.file, createWriteStream(target))
        if (part.file.truncated) {
          throw new BadRequestError(`${safeName} is larger than the ${maxMb} MB per-file limit`)
        }

        // An empty file input submits a zero-byte part; that is "nothing
        // chosen", not a file to reject.
        const written = await stat(target)
        if (written.size === 0) {
          await rm(target, { force: true })
          continue
        }

        const record = { name: isAsset ? part.fieldname : safeName, relPath: `in/${stagedName}` }
        if (isAsset) stagedAssets.push(record)
        else staged.push(record)
      }

      // A generator tool takes no uploads, so the CSRF check would otherwise
      // never run — there is no first file part to trigger it.
      await ensureCsrf()

      // Nothing uploaded? The user may be carrying a previous job's results
      // forward. Copy them in rather than making them download and re-upload.
      const fromJob = typeof fields.fromJob === 'string' ? fields.fromJob.trim() : ''
      if (staged.length === 0 && fromJob) {
        const source = await ctx.jobs.getJobForUser(fromJob, req.currentUser!.id)
        if (!source || source.status !== 'done') {
          throw new BadRequestError('Those earlier results are no longer available')
        }

        const { inDir } = await ensurePaths()
        for (const file of await ctx.jobs.listFiles(source.id)) {
          if (file.role !== 'output') continue
          if (staged.length >= ctx.config.MAX_FILES_PER_JOB) break
          // readable() re-checks containment, so a stored path cannot be used
          // to read outside the source job's directory.
          const from = await ctx.storage.readable(source.id, file.relPath)
          const stagedName = `${staged.length}-${file.name}`
          await copyFile(from, join(inDir, stagedName))
          staged.push({ name: file.name, relPath: `in/${stagedName}` })
        }
      }

      if (tool.inputMode !== 'none' && staged.length === 0) {
        throw new BadRequestError('Choose at least one image')
      }

      // Probe every upload before a job exists: reject bad input at the door
      // rather than discovering it in a worker.
      const { dir } = await ensurePaths()
      const inputs = []
      // Supporting files are probed with the same rigour as inputs: a logo is
      // still an untrusted upload heading for a decoder.
      for (const [role, list] of [
        ['input', staged],
        ['asset', stagedAssets],
      ] as const) {
        for (const file of list) {
          const probe = await probeImage(join(dir, file.relPath))
          inputs.push({ role, name: file.name, relPath: file.relPath, mime: probe.mime, bytes: probe.bytes })
        }
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
    const inputs = files.filter((f) => f.role === 'input')
    const outputs = files.filter((f) => f.role === 'output')

    // Only offer a comparison where there is genuinely something to compare
    // against: a generator tool has no original.
    const comparisons =
      outputs.length === inputs.length
        ? outputs.map((out, index) => ({ before: inputs[index]!, after: out }))
        : []

    return reply.view('job.njk', pageData(ctx, req, reply, {
      job,
      tool,
      inputs,
      outputs,
      comparisons,
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
