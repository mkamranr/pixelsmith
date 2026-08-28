import { registerHandwritingFaces, refreshRunnerLlmStatus, registry } from '@pixelsmith/core'
import { jobsRepo, openDatabase } from '@pixelsmith/db'
import { createProcessor, jobStorage, parseQueueNames, startWorker } from '@pixelsmith/jobs'
import { pino } from 'pino'
import { loadWorkerConfig } from './config.js'

/**
 * The job runner.
 *
 * One binary serves every queue; which queues a given container listens to is
 * configuration, not a different build. That keeps the offline bundle to a
 * single worker image while still allowing render or inference work to be
 * scaled separately by running more replicas with a narrower QUEUE_NAMES.
 *
 * Note it does NOT migrate the database — the API owns the schema. A worker
 * racing to migrate at startup is how you corrupt a deployment.
 */
async function main() {
  const config = loadWorkerConfig()
  const logger = pino({ level: config.LOG_LEVEL })

  const db = openDatabase(config.databasePath)
  const jobs = jobsRepo(db.db, { retentionMs: config.retentionMs })
  const storage = jobStorage(config.dataDir)

  /**
   * Registered once, in-process, rather than installed into the image:
   * fontconfig is not configured identically everywhere this runs, and a font
   * that is silently substituted looks exactly like one that was never asked
   * for. Logged so an operator can see which faces a signature can use.
   */
  const faces = registerHandwritingFaces(config.FONT_DIR)

  const processor = createProcessor({
    jobs,
    storage,
    registry,
    settings: {
      allowedRenderHosts: config.allowedRenderHosts,
      // So a tool can read settings changed while this process is running.
      dataDir: config.dataDir,
      ...(config.CHROMIUM_PATH ? { chromiumExecutablePath: config.CHROMIUM_PATH } : {}),
      ...(config.INFERENCE_URL ? { inferenceUrl: config.INFERENCE_URL } : {}),
      ...(config.QPDF_PATH ? { qpdfPath: config.QPDF_PATH } : {}),
      ...(config.SOFFICE_PATH ? { sofficePath: config.SOFFICE_PATH } : {}),
      ...(config.TESSERACT_PATH ? { tesseractPath: config.TESSERACT_PATH } : {}),
    },
    logger,
  })

  /**
   * Report whether a language model is reachable from here.
   *
   * The web process cannot answer this on our behalf: it sits on a different
   * network, and on the shipped compose these workers have no route off the
   * host at all. Whichever process does the work is the one whose reachability
   * decides whether the tools are offered.
   */
  const checkLlm = () => {
    void refreshRunnerLlmStatus(config.dataDir).catch((err: unknown) => {
      logger.debug({ err }, 'could not record language model reachability')
    })
  }
  checkLlm()
  const llmTimer = setInterval(checkLlm, 15_000)
  // Nothing should be kept alive by this alone.
  llmTimer.unref()

  const queueNames = parseQueueNames(config.QUEUE_NAMES)
  const worker = await startWorker({
    queueNames,
    redisUrl: config.REDIS_URL,
    concurrency: config.CONCURRENCY,
    jobTimeoutMs: config.jobTimeoutMs,
    processor,
    logger,
  })

  logger.info(
    {
      queues: queueNames,
      concurrency: config.CONCURRENCY,
      dataDir: config.dataDir,
      handwritingFaces: faces.length,
    },
    'Pixelsmith runner started',
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'draining')
    // close() waits for in-flight jobs, so a deploy does not abandon work
    // half-written on the shared volume.
    await worker.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Pixelsmith runner failed to start:', err)
  process.exit(1)
})
