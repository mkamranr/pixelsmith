import { relative } from 'node:path'
import { isPixelsmithError } from '@pixelsmith/contracts'
import { runTool, type Registry, type RuntimeSettings } from '@pixelsmith/core'
import type { JobsRepo } from '@pixelsmith/db'
import type { JobStorage } from './storage.js'

export interface ProcessorLogger {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface ProcessorDeps {
  jobs: JobsRepo
  storage: JobStorage
  registry: Registry
  /** Deployment settings handed to every tool, e.g. the render allowlist. */
  settings?: RuntimeSettings
  now?: () => number
  logger?: ProcessorLogger
}

/**
 * Executes one job. Shared by the in-process queue (development, single node)
 * and the BullMQ worker (production), so both take exactly the same path
 * through the same code.
 */
export function createProcessor(deps: ProcessorDeps) {
  const log = deps.logger

  return {
    async processJob(jobId: string): Promise<void> {
      const job = await deps.jobs.getJob(jobId)
      if (!job) {
        log?.error({ jobId }, 'job not found')
        return
      }
      // A redelivered message, or two workers racing, must not run twice.
      if (job.status !== 'queued') {
        log?.info({ jobId, status: job.status }, 'skipping job that is not queued')
        return
      }

      await deps.jobs.markRunning(jobId)

      try {
        const tool = deps.registry.get(job.toolId)
        const paths = deps.storage.paths(jobId)
        const files = await deps.jobs.listFiles(jobId)
        const inputs = files
          .filter((f) => f.role === 'input')
          .map((f) => ({ path: deps.storage.resolveFile(jobId, f.relPath), name: f.name }))

        const assets: Record<string, string> = {}
        for (const file of files.filter((f) => f.role === 'asset')) {
          assets[file.name] = deps.storage.resolveFile(jobId, file.relPath)
        }

        const outputs = await runTool(tool, {
          inputs,
          outDir: paths.outDir,
          params: job.params,
          assets,
          ...(deps.settings ? { settings: deps.settings } : {}),
          onProgress: (fraction) => {
            void deps.jobs.updateProgress(jobId, fraction * 100)
          },
        })

        await deps.jobs.addFiles(
          jobId,
          outputs.map((o) => ({
            role: 'output' as const,
            name: o.name,
            // Stored relative to the job directory so the database never holds
            // an absolute path that a later deployment would invalidate.
            relPath: relative(paths.dir, o.path),
            mime: o.mime,
            bytes: o.bytes,
          })),
        )

        await deps.jobs.markDone(jobId)
        log?.info({ jobId, tool: job.toolId, outputs: outputs.length }, 'job done')
      } catch (err) {
        // A bad upload is an expected outcome, not a worker crash: record it
        // against the job and stay alive for the next one.
        const code = isPixelsmithError(err) ? err.code : 'internal_error'
        const message = err instanceof Error ? err.message : String(err)
        await deps.jobs.markFailed(jobId, code, message)
        log?.error({ jobId, code, message }, 'job failed')
      }
    },
  }
}

export type Processor = ReturnType<typeof createProcessor>
