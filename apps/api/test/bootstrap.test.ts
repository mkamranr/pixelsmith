import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { bootstrapFirstAdmin } from '../src/bootstrap.js'
import { loadConfig } from '../src/config.js'
import { createContext } from '../src/context.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A context with nothing in it, in the given authentication mode. */
async function freshContext(authMode: 'open' | 'accounts') {
  const dir = await mkdtemp(join(tmpdir(), 'pixelsmith-bootstrap-'))
  dirs.push(dir)

  const ctx = await createContext(
    loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      COOKIE_SECRET: 'x'.repeat(48),
      QUEUE_DRIVER: 'inline',
      LOG_LEVEL: 'silent',
      AUTH_MODE: authMode,
    } as NodeJS.ProcessEnv),
  )

  const said: { fields: unknown; message?: string }[] = []
  const logger = {
    info: (fields: unknown, message?: string) => said.push({ fields, message }),
    error: () => undefined,
  }

  return { ctx, logger, said, async close() { await ctx.shutdown() } }
}

describe('the first administrator', () => {
  it('is created on an empty database when there are accounts', async () => {
    const h = await freshContext('accounts')

    await bootstrapFirstAdmin(h.ctx, h.logger)

    expect(await h.ctx.users.countUsers()).toBe(1)
    await h.close()
  })

  it('is printed once, because an isolated server has no way to send it', async () => {
    const h = await freshContext('accounts')

    await bootstrapFirstAdmin(h.ctx, h.logger)
    const printed = h.said.find((line) => String(line.message).includes('administrator'))

    expect(printed).toBeDefined()
    expect(String((printed!.fields as { password?: string }).password ?? '')).not.toBe('')
    await h.close()
  })

  it('is not created at all when there are no accounts', async () => {
    /**
     * With `AUTH_MODE=open` there is no sign-in page — the authentication routes
     * are never registered — so an administrator cannot be used for anything.
     * Creating one anyway put a password in the logs of every open deployment
     * for an account nobody could reach, and the installer went on to tell the
     * operator to go and find it.
     */
    const h = await freshContext('open')

    await bootstrapFirstAdmin(h.ctx, h.logger)

    expect(await h.ctx.users.countUsers()).toBe(0)
    await h.close()
  })

  it('prints no password when it has created no account', async () => {
    const h = await freshContext('open')

    await bootstrapFirstAdmin(h.ctx, h.logger)
    const leaked = h.said.filter((line) => 'password' in ((line.fields ?? {}) as object))

    expect(leaked).toEqual([])
    await h.close()
  })

  it('says why it did nothing, so the log is not silent about it', async () => {
    const h = await freshContext('open')

    await bootstrapFirstAdmin(h.ctx, h.logger)

    expect(h.said.map((line) => line.message).join(' ')).toMatch(/no accounts|open/i)
    await h.close()
  })

  it('leaves an existing set of accounts alone', async () => {
    const h = await freshContext('accounts')
    await h.ctx.users.createUser({
      email: 'someone@example.test',
      name: 'Someone',
      password: 'a-sufficiently-long-password',
    })

    await bootstrapFirstAdmin(h.ctx, h.logger)

    expect(await h.ctx.users.countUsers()).toBe(1)
    await h.close()
  })
})
