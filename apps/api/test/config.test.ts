import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsmith-config-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const env = (extra: Record<string, string> = {}) =>
  ({ NODE_ENV: 'test', DATA_DIR: dir, LOG_LEVEL: 'silent', ...extra }) as NodeJS.ProcessEnv

describe('empty environment variables', () => {
  /**
   * Docker Compose has no way to express "unset": `${FOO:-}` passes an empty
   * string. A schema that only tolerates an *absent* variable therefore fails
   * to start under Compose, which is how this was found.
   */
  it('treats an empty string as unset, the way Compose means it', () => {
    const config = loadConfig(
      env({
        COOKIE_SECRET: '',
        BOOTSTRAP_ADMIN_EMAIL: '',
        BOOTSTRAP_ADMIN_PASSWORD: '',
        INFERENCE_URL: '',
        QPDF_PATH: '',
        SOFFICE_PATH: '',
        TESSERACT_PATH: '',
        CHROMIUM_PATH: '',
      }),
    )
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined()
    expect(config.INFERENCE_URL).toBeUndefined()
    expect(config.QPDF_PATH).toBeUndefined()
    // A secret is still produced, generated and persisted rather than demanded.
    expect(config.cookieSecret.length).toBeGreaterThanOrEqual(32)
  })

  it('still honours values that are actually set', () => {
    const config = loadConfig(
      env({
        COOKIE_SECRET: 'z'.repeat(48),
        BOOTSTRAP_ADMIN_EMAIL: 'ops@example.test',
        QPDF_PATH: '/usr/bin/qpdf',
      }),
    )
    expect(config.cookieSecret).toBe('z'.repeat(48))
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBe('ops@example.test')
    expect(config.QPDF_PATH).toBe('/usr/bin/qpdf')
  })

  it('still rejects a value that is present but wrong', () => {
    expect(() => loadConfig(env({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }))).toThrow(/email/i)
    expect(() => loadConfig(env({ COOKIE_SECRET: 'too-short' }))).toThrow(/32/)
  })

  it('keeps the generated secret across restarts', () => {
    const first = loadConfig(env())
    const second = loadConfig(env())
    // Otherwise every restart signs everyone out.
    expect(second.cookieSecret).toBe(first.cookieSecret)
  })

  it('defaults to open access', () => {
    expect(loadConfig(env()).AUTH_MODE).toBe('open')
    expect(loadConfig(env({ AUTH_MODE: 'accounts' })).AUTH_MODE).toBe('accounts')
  })
})
