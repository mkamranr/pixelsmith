import type { JobsRepo } from '@pixelsmith/db'
import type { JobStorage } from './storage.js'
import type { ProcessorLogger } from './processor.js'

export interface SweeperDeps {
  jobs: JobsRepo
  storage: JobStorage
  now?: () => number
  logger?: ProcessorLogger
}

export interface SweepResult {
  jobsPurged: number
  orphansRemoved: number
}

/**
 * Deletes expired job files, and reconciles disk against the database.
 *
 * The orphan pass matters as much as the expiry pass: a crash between creating
 * a job directory and committing its row would otherwise leave uploaded images
 * on disk with nothing tracking them, and nothing to ever clean them up.
 */
export function createSweeper(deps: SweeperDeps) {
  return {
    async sweep(): Promise<SweepResult> {
      let jobsPurged = 0
      let orphansRemoved = 0

      for (const job of await deps.jobs.findExpired()) {
        await deps.storage.remove(job.id)
        // Mark after deleting: if we die in between, the next sweep retries.
        await deps.jobs.markExpired(job.id)
        jobsPurged++
      }

      for (const id of await deps.storage.listJobDirs()) {
        if (!(await deps.jobs.getJob(id))) {
          await deps.storage.remove(id)
          orphansRemoved++
        }
      }

      if (jobsPurged || orphansRemoved) {
        deps.logger?.info({ jobsPurged, orphansRemoved }, 'sweep complete')
      }
      return { jobsPurged, orphansRemoved }
    },
  }
}
