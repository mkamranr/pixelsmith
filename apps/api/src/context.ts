import { mkdir } from 'node:fs/promises'
import { auditRepo, jobsRepo, migrateDatabase, openDatabase, sessionsRepo, usersRepo } from '@pixelsmith/db'
import { isLlmUsable, readLlmSettings, readRunnerLlmStatus, registry } from '@pixelsmith/core'
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
  /**
   * What this server can currently do beyond processing files. Held here so a
   * page render can ask without awaiting a file read, and refreshed when the
   * settings change rather than polled.
   */
  capabilities: { llm: boolean }
  refreshCapabilities(): Promise<void>
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
      ...(config.QPDF_PATH ? { qpdfPath: config.QPDF_PATH } : {}),
      ...(config.SOFFICE_PATH ? { sofficePath: config.SOFFICE_PATH } : {}),
      ...(config.TESSERACT_PATH ? { tesseractPath: config.TESSERACT_PATH } : {}),
    },
    logger,
  })
  const sweeper = createSweeper({ jobs, storage, logger })

  const queue: JobQueue =
    config.QUEUE_DRIVER === 'redis'
      ? await bullQueue({ redisUrl: config.REDIS_URL, logger })
      : inlineQueue(processor, logger)

  const capabilities = { llm: false }

  const ctx = {
    config,
    db,
    users,
    sessions,
    jobs,
    audit,
    storage,
    registry,
    capabilities,
    async refreshCapabilities() {
      // Both halves: configured and reached from here, and confirmed by the
      // workers for this same endpoint. One without the other offers a tool
      // that cannot run.
      capabilities.llm = isLlmUsable(
        await readLlmSettings(config.dataDir),
        await readRunnerLlmStatus(config.dataDir),
      )
    },
    queue,
    sweeper,
    async shutdown() {
      await queue.close()
      db.close()
    },
  }

  // Decided at start-up, whenever the settings are saved, and on a timer — the
  // workers report on their own schedule, and a model that goes away should
  // take its tools out of the menus without anybody restarting anything.
  await ctx.refreshCapabilities()
  const watch = setInterval(() => void ctx.refreshCapabilities().catch(() => {}), 10_000)
  watch.unref()
  return ctx
}
