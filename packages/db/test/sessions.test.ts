import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { sessionsRepo, SESSION_TTL_MS } from '../src/repos/sessions.js'
import { usersRepo } from '../src/repos/users.js'
import { sessions } from '../src/schema.js'
import { freshDb } from './helpers/db.js'

let handle: ReturnType<typeof freshDb>
let now = 1_700_000_000_000
const clock = () => now
let userId: string

beforeEach(async () => {
  handle = freshDb()
  now = 1_700_000_000_000
  const user = await usersRepo(handle.db, { now: clock }).createUser({
    email: 's@example.test',
    name: 'S',
    password: 'a-sufficiently-long-password',
  })
  userId = user.id
})
afterEach(() => handle.close())

const repo = () => sessionsRepo(handle.db, { now: clock })

describe('sessions', () => {
  it('issues a token that resolves back to its user', async () => {
    const { token } = await repo().createSession(userId, {})
    const resolved = await repo().resolveSession(token)
    expect(resolved?.user.id).toBe(userId)
  })

  it('never stores the token itself, only a hash of it', async () => {
    const { token } = await repo().createSession(userId, {})
    const rows = handle.db.select().from(sessions).all()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not resolve a token that was never issued', async () => {
    expect(await repo().resolveSession('made-up-token')).toBeUndefined()
  })

  it('stops resolving a session once it has expired', async () => {
    const { token } = await repo().createSession(userId, {})
    now += SESSION_TTL_MS + 1
    expect(await repo().resolveSession(token)).toBeUndefined()
  })

  it('records the originating ip and user agent for the audit trail', async () => {
    const { token } = await repo().createSession(userId, { ip: '10.0.0.9', userAgent: 'curl/8' })
    const resolved = await repo().resolveSession(token)
    expect(resolved?.session).toMatchObject({ ip: '10.0.0.9', userAgent: 'curl/8' })
  })

  it('destroys a single session on logout, leaving other sessions alone', async () => {
    const a = await repo().createSession(userId, {})
    const b = await repo().createSession(userId, {})
    await repo().destroySession(a.token)
    expect(await repo().resolveSession(a.token)).toBeUndefined()
    expect(await repo().resolveSession(b.token)).toBeTruthy()
  })

  it('destroys every session for a user, for a forced sign-out', async () => {
    const a = await repo().createSession(userId, {})
    const b = await repo().createSession(userId, {})
    await repo().destroyAllForUser(userId)
    expect(await repo().resolveSession(a.token)).toBeUndefined()
    expect(await repo().resolveSession(b.token)).toBeUndefined()
  })

  it('sweeps expired rows so the table does not grow without bound', async () => {
    await repo().createSession(userId, {})
    await repo().createSession(userId, {})
    now += SESSION_TTL_MS + 1
    expect(await repo().purgeExpired()).toBe(2)
    expect(handle.db.select().from(sessions).all()).toHaveLength(0)
  })

  it('does not resolve a session whose user was deleted', async () => {
    const { token } = await repo().createSession(userId, {})
    await usersRepo(handle.db, { now: clock }).deleteUser(userId)
    expect(await repo().resolveSession(token)).toBeUndefined()
  })
})
