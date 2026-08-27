import type { FastifyInstance } from 'fastify'
import { STICKERS, STICKER_CATEGORIES } from '@pixelsmith/core'
import type { AppContext } from '../context.js'
import { NotFoundError } from '../errors.js'
import { intakeJob } from '../intake.js'
import { zodToFields } from '../schema-doc.js'

/**
 * The JSON API. The HTML pages do not depend on it — they are server-rendered —
 * so this exists for scripting and automation, and its shape is documented at
 * /api/docs rather than being an internal detail.
 */
export async function registerApi(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', async () => ({ status: 'ok', queue: ctx.queue.driver }))

  /**
   * The sticker catalogue. Served rather than duplicated into the client, so a
   * preview cannot draw different geometry from the final render.
   */
  app.get('/api/stickers', async () => ({
    categories: STICKER_CATEGORIES,
    stickers: STICKERS.map((s) => ({
      id: s.id, label: s.label, category: s.category, viewBox: s.viewBox, path: s.path,
    })),
  }))

  app.get('/api/tools', async () => ({
    tools: ctx.registry.list().map((t) => ({
      id: t.id,
      title: t.title,
      family: t.family,
      group: t.ui.group,
      blurb: t.ui.blurb ?? null,
      accepts: t.accepts,
      /** 'none' means the tool builds its output from settings alone. */
      inputMode: t.inputMode ?? 'files',
      params: zodToFields(t),
    })),
  }))

  app.get('/api/tools/:toolId', async (req) => {
    const { toolId } = req.params as { toolId: string }
    if (!ctx.registry.has(toolId)) throw new NotFoundError('Tool')
    const t = ctx.registry.get(toolId)
    return {
      id: t.id,
      title: t.title,
      family: t.family,
      group: t.ui.group,
      blurb: t.ui.blurb ?? null,
      accepts: t.accepts,
      inputMode: t.inputMode ?? 'files',
      params: zodToFields(t),
    }
  })

  /**
   * Create a job.
   *
   * One multipart request: `tool` names the tool, `files` carries the inputs,
   * and every other field is one of that tool's settings. Supporting files — a
   * signature, a watermark image — go in the field the tool declares for them.
   *
   * The same intake as the browser form, deliberately, so a file accepted in one
   * is accepted in the other and the refusals read the same. No CSRF token is
   * required: a script has no page to take one from.
   */
  app.post('/api/jobs', { preHandler: app.requireUser }, async (req, reply) => {
    const { jobId, toolId } = await intakeJob({ app, ctx, req, reply, csrf: false })
    const job = await ctx.jobs.getJobForUser(jobId, req.currentUser!.id)

    return reply.status(202).send({
      id: jobId,
      tool: toolId,
      status: job?.status ?? 'queued',
      statusUrl: `/api/jobs/${jobId}`,
      eventsUrl: `/api/jobs/${jobId}/events`,
    })
  })

  app.get('/api/jobs/:id', { preHandler: app.requireUser }, async (req) => {
    const { id } = req.params as { id: string }
    const job = await ctx.jobs.getJobForUser(id, req.currentUser!.id)
    if (!job) throw new NotFoundError('Job')

    const files = await ctx.jobs.listFiles(job.id)
    return {
      id: job.id,
      tool: job.toolId,
      status: job.status,
      progress: job.progress,
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
      outputs: files
        .filter((f) => f.role === 'output')
        .map((f) => ({
          id: f.id,
          name: f.name,
          mime: f.mime,
          bytes: f.bytes,
          url: `/jobs/${job.id}/files/${f.id}`,
        })),
    }
  })

  /**
   * Progress as server-sent events. The job page uses this to update in place;
   * without JavaScript the page falls back to a meta refresh, so the feature
   * degrades rather than disappearing.
   */
  app.get('/api/jobs/:id/events', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await ctx.jobs.getJobForUser(id, req.currentUser!.id)
    if (!job) throw new NotFoundError('Job')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    req.raw.on('close', () => {
      closed = true
    })

    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)

    while (!closed) {
      const current = await ctx.jobs.getJob(id)
      if (!current) break
      send({ status: current.status, progress: current.progress })
      if (['done', 'failed', 'expired', 'cancelled'].includes(current.status)) break
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!closed) reply.raw.end()
    return reply
  })
}
