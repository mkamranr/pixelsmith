import type { Processor } from './processor.js'
import type { ProcessorLogger } from './processor.js'

/**
 * The queue seam. Two drivers implement it:
 * - `inlineQueue` runs work in-process, so development and single-node
 *   deployments need no Redis at all, and tests stay hermetic.
 * - `bullQueue` hands work to BullMQ for the real multi-worker deployment.
 */
export interface JobQueue {
  readonly driver: string
  enqueue(jobId: string, queueName: string): Promise<void>
  close(): Promise<void>
}

export function inlineQueue(processor: Processor, logger?: ProcessorLogger): JobQueue {
  const inFlight = new Set<Promise<void>>()

  return {
    driver: 'inline',
    async enqueue(jobId: string) {
      // Deliberately not awaited: the HTTP response returns immediately and the
      // client follows progress, exactly as it would with a real broker.
      const task = processor
        .processJob(jobId)
        .catch((err) => logger?.error({ jobId, err: String(err) }, 'inline job crashed'))
        .finally(() => inFlight.delete(task))
      inFlight.add(task)
    },
    async close() {
      await Promise.allSettled([...inFlight])
    },
  }
}

export interface BullQueueOptions {
  redisUrl: string
  logger?: ProcessorLogger
}

/**
 * Lazily imports bullmq so that an inline deployment never loads it, and a
 * development run works with no Redis present.
 */
export async function bullQueue(options: BullQueueOptions): Promise<JobQueue> {
  const { Queue } = await import('bullmq')
  const { Redis } = await import('ioredis')

  const connection = new Redis(options.redisUrl, { maxRetriesPerRequest: null })
  const queues = new Map<string, InstanceType<typeof Queue>>()

  const queueFor = (name: string) => {
    let q = queues.get(name)
    if (!q) {
      q = new Queue(name, { connection })
      queues.set(name, q)
    }
    return q
  }

  return {
    driver: 'redis',
    async enqueue(jobId: string, queueName: string) {
      await queueFor(queueName).add(
        'process',
        { jobId },
        {
          jobId,
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 1000 },
          attempts: 1,
        },
      )
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()))
      connection.disconnect()
    },
  }
}
