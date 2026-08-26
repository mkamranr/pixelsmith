import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { runTool } from '@pixelsmith/core'
import type { AppContext } from '../context.js'
import { BadRequestError, NotFoundError } from '../errors.js'

/**
 * Synchronous preview rendering, for tools where seeing the result before
 * committing is the whole point (HTML to image).
 *
 * Deliberately narrow: only tools that take no uploads, a small forced viewport,
 * its own rate limit, and a temporary directory that is always removed. It does
 * not touch the job tables — a preview is not work anyone should have to clean
 * up, and it must never occupy the queue a real job is waiting in.
 */
const PREVIEWABLE = new Set(['html-to-image'])

export async function registerPreview(app: FastifyInstance, ctx: AppContext) {
  app.post(
    '/api/preview/:toolId',
    {
      preHandler: app.requireUser,
      config: {
        // Each preview costs a browser render, so it gets a tighter budget than
        // ordinary requests.
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const { toolId } = req.params as { toolId: string }
      if (!PREVIEWABLE.has(toolId) || !ctx.registry.has(toolId)) {
        throw new NotFoundError('Preview for this tool')
      }

      const tool = ctx.registry.get(toolId)
      if (tool.inputMode !== 'none') {
        throw new BadRequestError('Only generator tools can be previewed')
      }

      const params = ctx.registry.parseParams(toolId, {
        ...(req.body as Record<string, unknown>),
        // A preview is for judging layout, not for keeping: cap the work.
        fullPage: false,
      })

      const dir = await mkdtemp(join(tmpdir(), 'pixelsmith-preview-'))
      try {
        const outputs = await runTool(tool, {
          inputs: [],
          outDir: dir,
          params,
          settings: {
            allowedRenderHosts: ctx.config.allowedRenderHosts,
            ...(ctx.config.CHROMIUM_PATH ? { chromiumExecutablePath: ctx.config.CHROMIUM_PATH } : {}),
            ...(ctx.config.INFERENCE_URL ? { inferenceUrl: ctx.config.INFERENCE_URL } : {}),
          },
        })

        const first = outputs[0]
        if (!first) throw new BadRequestError('Nothing was rendered')

        reply.header('Content-Type', first.mime)
        reply.header('Cache-Control', 'no-store')
        return reply.send(await readFile(first.path))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
}
