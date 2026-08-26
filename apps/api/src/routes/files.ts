import { createReadStream } from 'node:fs'
import archiver from 'archiver'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { NotFoundError } from '../errors.js'

export async function registerFiles(app: FastifyInstance, ctx: AppContext) {
  /** Download one output file. */
  app.get('/jobs/:id/files/:fileId', { preHandler: app.requireUser }, async (req, reply) => {
    const { id, fileId } = req.params as { id: string; fileId: string }

    const job = await ctx.jobs.getJobForUser(id, req.currentUser!.id)
    if (!job) throw new NotFoundError('Job')

    // Inputs are served as well as outputs, so the results page can show a
    // before/after comparison. Supporting assets are deliberately excluded:
    // they are an implementation detail, not the user's file.
    const file = (await ctx.jobs.listFiles(job.id)).find(
      (f) => f.id === fileId && (f.role === 'output' || f.role === 'input'),
    )
    if (!file) throw new NotFoundError('File')

    // readable() follows symlinks and re-checks containment before we open it.
    const real = await ctx.storage.readable(job.id, file.relPath)

    reply.header('Content-Type', file.mime)
    reply.header('Content-Length', String(file.bytes))
    // Quoted filename, and nothing from the path — the browser gets the display
    // name we recorded, never a value that could contain a header separator.
    reply.header('Content-Disposition', `attachment; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`)
    return reply.send(createReadStream(real))
  })

  /** Download every output as one zip, built streaming so nothing buffers. */
  app.get('/jobs/:id/download', { preHandler: app.requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const job = await ctx.jobs.getJobForUser(id, req.currentUser!.id)
    if (!job) throw new NotFoundError('Job')

    const outputs = (await ctx.jobs.listFiles(job.id)).filter((f) => f.role === 'output')
    if (outputs.length === 0) throw new NotFoundError('Results')

    const archive = archiver('zip', { zlib: { level: 6 } })
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="pixelsmith-${job.id.slice(0, 8)}.zip"`)

    for (const file of outputs) {
      archive.file(await ctx.storage.readable(job.id, file.relPath), { name: file.name })
    }
    // Errors after headers are sent can only be logged; the zip will be short.
    archive.on('error', (err) => req.log.error({ err, jobId: job.id }, 'zip failed'))
    void archive.finalize()

    return reply.send(archive)
  })
}
