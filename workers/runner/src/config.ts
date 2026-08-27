import { resolve } from 'node:path'
import { z } from 'zod'

/**
 * Worker configuration.
 *
 * Deliberately separate from the API's config: a worker has no cookies, no
 * sessions and no HTTP surface, and sharing one schema would mean each process
 * validating settings it has no business knowing about.
 */
const Schema = z.object({
  DATA_DIR: z.string().default('./data'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  /** Which queues this process serves. Splitting them lets render scale apart. */
  QUEUE_NAMES: z.string().default('image,render,ml'),
  CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  RETENTION_HOURS: z.coerce.number().positive().default(2),
  JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(15),
  INFERENCE_URL: z.string().optional(),
  CHROMIUM_PATH: z.string().optional(),
  QPDF_PATH: z.string().optional(),
  SOFFICE_PATH: z.string().optional(),
  TESSERACT_PATH: z.string().optional(),
  ALLOWED_RENDER_HOSTS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid worker configuration:\n${detail}`)
  }
  const raw = parsed.data
  const dataDir = resolve(raw.DATA_DIR)

  return {
    ...raw,
    dataDir,
    databasePath: resolve(dataDir, 'pixelsmith.sqlite'),
    retentionMs: raw.RETENTION_HOURS * 60 * 60 * 1000,
    jobTimeoutMs: raw.JOB_TIMEOUT_MINUTES * 60 * 1000,
    allowedRenderHosts: raw.ALLOWED_RENDER_HOSTS.split(',').map((h) => h.trim()).filter(Boolean),
  }
}
