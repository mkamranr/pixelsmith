import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  /** Everything mutable lives under here: the database and all job files. */
  DATA_DIR: z.string().default('./data'),

  /**
   * `open` (the default) needs no sign-in: anyone who can reach the host can
   * use every tool. Each browser still gets an anonymous visitor cookie, purely
   * so one person's uploads are not listed and downloadable by everyone else on
   * the network — identity, not authentication.
   *
   * `accounts` restores per-user sign-in, an administrator, and the audit trail.
   */
  AUTH_MODE: z.enum(['open', 'accounts']).default('open'),

  /** Signs the session cookie. Required in production; generated in dev. */
  COOKIE_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),

  /** `inline` needs no Redis, which is what makes local development possible. */
  QUEUE_DRIVER: z.enum(['inline', 'redis']).default('inline'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  RETENTION_HOURS: z.coerce.number().positive().default(2),
  SWEEP_INTERVAL_MINUTES: z.coerce.number().positive().default(10),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  MAX_FILES_PER_JOB: z.coerce.number().int().positive().default(30),

  /** Creates the first admin on an empty database, then never again. */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  /**
   * Hosts the HTML renderer may fetch, comma separated. Empty — the default —
   * means URL rendering is refused outright and only pasted HTML is rendered.
   */
  ALLOWED_RENDER_HOSTS: z.string().default(''),
  /** Set when the container bundles its own Chromium. */
  CHROMIUM_PATH: z.string().optional(),

  /**
   * Paths to the bundled document tools. Absent means the features that need
   * them report themselves unavailable, rather than failing obscurely.
   */
  QPDF_PATH: z.string().optional(),
  SOFFICE_PATH: z.string().optional(),
  TESSERACT_PATH: z.string().optional(),

  /**
   * Base URL of the inference sidecar. Unset means the machine-learning tools
   * report themselves unavailable instead of failing obscurely.
   */
  INFERENCE_URL: z.string().optional(),

  TRUST_PROXY: bool.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

export type Config = ReturnType<typeof loadConfig>

/**
 * A stable cookie secret for development.
 *
 * Generating a fresh one per start signs every user out on every restart, and
 * leaves orphaned session rows behind. Production requires COOKIE_SECRET to be
 * set explicitly (see below); this only covers the local case, and the file is
 * written owner-only.
 */
function developmentCookieSecret(dataDir: string): string {
  const path = resolve(dataDir, '.cookie-secret')
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim()
      if (existing.length >= 32) return existing
    }
    const generated = randomBytes(32).toString('hex')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path, generated, { mode: 0o600 })
    return generated
  } catch {
    // A read-only data directory is not a reason to fail to boot.
    return randomBytes(32).toString('hex')
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${detail}`)
  }
  const raw = parsed.data

  if (raw.NODE_ENV === 'production' && !raw.COOKIE_SECRET) {
    // Failing loudly here beats silently rotating everyone's session on restart.
    throw new Error('COOKIE_SECRET must be set in production (32+ characters)')
  }

  const dataDir = resolve(raw.DATA_DIR)

  return {
    ...raw,
    dataDir,
    databasePath: resolve(dataDir, 'pixelsmith.sqlite'),
    cookieSecret: raw.COOKIE_SECRET ?? developmentCookieSecret(dataDir),
    sessionTtlMs: raw.SESSION_TTL_HOURS * 60 * 60 * 1000,
    retentionMs: raw.RETENTION_HOURS * 60 * 60 * 1000,
    sweepIntervalMs: raw.SWEEP_INTERVAL_MINUTES * 60 * 1000,
    allowedRenderHosts: raw.ALLOWED_RENDER_HOSTS.split(',').map((h) => h.trim()).filter(Boolean),
    isProduction: raw.NODE_ENV === 'production',
    isOpenAccess: raw.AUTH_MODE === 'open',
  }
}
