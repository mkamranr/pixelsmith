import { createWriteStream } from 'node:fs'
import { copyFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { deriveName, LlmUnavailableError, probeForTool, probeImage } from '@pixelsmith/core'
import { BadRequestError, NotFoundError, TooManyFilesError } from './errors.js'
import { coerceFormParams } from './params.js'
import type { AppContext } from './context.js'
import { jobFor } from './job-access.js'

/** How many supporting files one job may carry — a mark, a signature. */
const MAX_ASSETS = 4

export interface IntakeOptions {
  app: FastifyInstance
  ctx: AppContext
  req: FastifyRequest
  reply: FastifyReply
  /**
   * The tool, when the route already names it. Left out for the API, where it
   * arrives as a field: nothing before the probe needs to know which tool it
   * is, so it can be read once the parts have been streamed.
   */
  toolId?: string
  /**
   * Whether a CSRF token is required. Forms carry one, scraped from the page
   * they were served on. An API request has no page to take one from, and
   * demanding one would make the API unusable.
   */
  csrf: boolean
}

/**
 * Take an upload and enqueue a job. The one intake there is.
 *
 * Both the browser form and the API come through here, deliberately: when they
 * had separate implementations, the form validated inputs one way and the
 * worker another, and a PDF tool would accept a PNG at the door and fail later
 * in a worker. One path, one set of rules, one set of error messages.
 *
 * Files are streamed to disk under a job id generated up front, before the
 * database row exists. A crash in between leaves an orphan directory, which the
 * sweeper reclaims — the alternative, buffering entire uploads in memory to keep
 * the write atomic, is how you run a server out of RAM.
 */
export async function intakeJob(options: IntakeOptions): Promise<{ jobId: string; toolId: string }> {
  const { app, ctx, req, reply, csrf } = options
  const maxMb = Math.round(ctx.config.MAX_UPLOAD_BYTES / (1024 * 1024))
  const jobId = randomUUID()
  const fields: Record<string, unknown> = {}
  const staged: { name: string; relPath: string }[] = []
  const stagedAssets: { name: string; relPath: string }[] = []

  /**
   * Validate CSRF from the streamed fields.
   *
   * The token is the first field in the form, so this runs before a single byte
   * of file data is written — a forged request must not be able to make us
   * spend disk on it. The shared hook is reused rather than reimplemented, so
   * there is still only one CSRF implementation on the server.
   */
  let csrfChecked = false
  const ensureCsrf = async () => {
    if (!csrf || csrfChecked) return
    ;(req as { body?: unknown }).body = fields
    await new Promise<void>((resolve, reject) => {
      app.csrfProtection(req, reply, (err?: unknown) => (err ? reject(err as Error) : resolve()))
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
      if (isAsset && stagedAssets.length >= MAX_ASSETS) {
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

    const toolId = options.toolId ?? String(fields.tool ?? '').trim()
    if (!toolId || !ctx.registry.has(toolId)) throw new NotFoundError('Tool')
    const tool = ctx.registry.get(toolId)

    // Refused here rather than in a worker, so the caller hears why instead of
    // watching a job fail.
    if (tool.requires === 'llm' && !ctx.capabilities.llm) {
      throw new LlmUnavailableError(
        'configure one under Settings before using the tools that need it',
      )
    }

    // Nothing uploaded? The caller may be carrying a previous job's results
    // forward. Copy them in rather than making them download and re-upload.
    const fromJob = typeof fields.fromJob === 'string' ? fields.fromJob.trim() : ''
    if (staged.length === 0 && fromJob) {
      const source = await jobFor(ctx, req, fromJob)
      if (!source || source.status !== 'done') {
        throw new BadRequestError('Those earlier results are no longer available')
      }

      const { inDir } = await ensurePaths()
      for (const file of await ctx.jobs.listFiles(source.id)) {
        if (file.role !== 'output') continue
        if (staged.length >= ctx.config.MAX_FILES_PER_JOB) break
        // readable() re-checks containment, so a stored path cannot be used to
        // read outside the source job's directory.
        const from = await ctx.storage.readable(source.id, file.relPath)
        const stagedName = `${staged.length}-${file.name}`
        await copyFile(from, join(inDir, stagedName))
        staged.push({ name: file.name, relPath: `in/${stagedName}` })
      }
    }

    if (tool.inputMode !== 'none' && staged.length === 0) {
      throw new BadRequestError(`${tool.title} needs at least one file`)
    }

    // Probe every upload before a job exists: reject bad input at the door
    // rather than discovering it in a worker.
    const { dir } = await ensurePaths()
    const inputs = []
    for (const file of staged) {
      // The same validator the worker uses, so nothing passes intake only to
      // fail inside the job.
      const probe = await probeForTool(tool, join(dir, file.relPath))
      inputs.push({
        role: 'input' as const,
        name: file.name,
        relPath: file.relPath,
        mime: probe.mime,
        bytes: probe.bytes,
      })
    }
    // Supporting files are pictures whatever the tool takes — a watermark logo
    // is a logo — and are probed with the same rigour as inputs.
    for (const file of stagedAssets) {
      const probe = await probeImage(join(dir, file.relPath))
      inputs.push({
        role: 'asset' as const,
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

    return { jobId: job.id, toolId }
  } catch (err) {
    await ctx.storage.remove(jobId).catch(() => {})
    throw err
  }
}
