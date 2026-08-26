import type { Processor, ProcessorLogger } from './processor.js'

export interface WorkerOptions {
  /** Queues to consume. One process can serve several. */
  queueNames: string[]
  redisUrl: string
  /** Jobs run at once per queue. Image work is CPU-bound, so keep this near core count. */
  concurrency: number
  processor: Processor
  logger?: ProcessorLogger
  /** Wall-clock ceiling for a single job, after which it is failed. */
  jobTimeoutMs?: number
}

export interface RunningWorker {
  close(): Promise<void>
}

/**
 * Consume jobs from Redis.
 *
 * Deliberately `attempts: 1` at the producer, and no retry here: these jobs are
 * deterministic image transforms. If one failed it will fail again, and retrying
 * only burns CPU and delays the queue. A genuinely transient failure (the
 * inference sidecar restarting) is reported to the user, who can resubmit — that
 * is honest, where a silent retry loop is not.
 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { Worker } = await import('bullmq')
  const { Redis } = await import('ioredis')

  // BullMQ requires this to be null for blocking commands.
  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null })
  const log = options.logger

  const workers = options.queueNames.map((queueName) => {
    const worker = new Worker(
      queueName,
      async (job) => {
        const jobId = (job.data as { jobId?: string }).jobId
        if (!jobId) {
          log?.error({ queue: queueName, bullJobId: job.id }, 'message had no job id')
          return
        }
        await options.processor.processJob(jobId)
      },
      {
        connection,
        concurrency: options.concurrency,
        ...(options.jobTimeoutMs ? { lockDuration: options.jobTimeoutMs } : {}),
      },
    )

    worker.on('failed', (job, err) => {
      // The processor records failures against the job itself; this is only for
      // the operator's log, so a crashed worker is visible in `docker logs`.
      log?.error({ queue: queueName, bullJobId: job?.id, err: String(err) }, 'worker job failed')
    })
    worker.on('error', (err) => {
      log?.error({ queue: queueName, err: String(err) }, 'worker error')
    })

    log?.info({ queue: queueName, concurrency: options.concurrency }, 'worker listening')
    return worker
  })

  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()))
      connection.disconnect()
    },
  }
}

/** Parse a comma-separated queue list, with a sane default. */
export function parseQueueNames(raw: string | undefined): string[] {
  const names = (raw ?? 'image,render,ml')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  return names.length > 0 ? names : ['image', 'render', 'ml']
}
