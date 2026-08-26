import { mkdir } from 'node:fs/promises'
import { auditRepo, jobsRepo, migrateDatabase, openDatabase, sessionsRepo, usersRepo } from '@pixelsmith/db'
import { registry } from '@pixelsmith/core'
import { bullQueue, createProcessor, createSweeper, inlineQueue, jobStorage, type JobQueue } from '@pixelsmith/jobs'
import type { Config } from './config.js'

export interface AppLogger {
  info(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface AppContext {
  config: Config
  db: ReturnType<typeof openDatabase>
  users: ReturnType<typeof usersRepo>
  sessions: ReturnType<typeof sessionsRepo>
  jobs: ReturnType<typeof jobsRepo>
  audit: ReturnType<typeof auditRepo>
  storage: ReturnType<typeof jobStorage>
  registry: typeof registry
  queue: JobQueue
  sweeper: ReturnType<typeof createSweeper>
  shutdown(): Promise<void>
}

/**
 * Wires the application together. Everything the routes touch is constructed
 * here and passed in, so nothing reaches for a module-level singleton and tests
 * can build a whole app against a temporary directory.
 */
export async function createContext(config: Config, logger?: AppLogger): Promise<AppContext> {
  await mkdir(config.dataDir, { recursive: true })

  const db = openDatabase(config.databasePath)
  migrateDatabase(db.db)

  const users = usersRepo(db.db)
  const sessions = sessionsRepo(db.db)
  const jobs = jobsRepo(db.db, { retentionMs: config.retentionMs })
  const audit = auditRepo(db.db)
  const storage = jobStorage(config.dataDir)

  const processor = createProcessor({
    jobs,
    storage,
    registry,
    settings: {
      allowedRenderHosts: config.allowedRenderHosts,
      ...(config.CHROMIUM_PATH ? { chromiumExecutablePath: config.CHROMIUM_PATH } : {}),
      ...(config.INFERENCE_URL ? { inferenceUrl: config.INFERENCE_URL } : {}),
    },
    logger,
  })
  const sweeper = createSweeper({ jobs, storage, logger })

  const queue: JobQueue =
    config.QUEUE_DRIVER === 'redis'
      ? await bullQueue({ redisUrl: config.REDIS_URL, logger })
      : inlineQueue(processor, logger)

  return {
    config,
    db,
    users,
    sessions,
    jobs,
    audit,
    storage,
    registry,
    queue,
    sweeper,
    async shutdown() {
      await queue.close()
      db.close()
    },
  }
}
