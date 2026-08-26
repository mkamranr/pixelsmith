import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { usersRepo, LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from '../src/repos/users.js'
import {
  AccountDisabledError,
  AccountLockedError,
  AuthenticationError,
  DuplicateEmailError,
  WeakPasswordError,
} from '../src/errors.js'
import { freshDb } from './helpers/db.js'

let handle: ReturnType<typeof freshDb>
let now = 1_700_000_000_000
const clock = () => now

beforeEach(() => {
  handle = freshDb()
  now = 1_700_000_000_000
})
afterEach(() => handle.close())

const repo = () => usersRepo(handle.db, { now: clock })
const GOOD = 'a-sufficiently-long-password'

describe('createUser', () => {
  it('stores a user and never keeps the plaintext password', async () => {
    const user = await repo().createUser({ email: 'a@example.test', name: 'Ada', password: GOOD })
    expect(user).toMatchObject({ email: 'a@example.test', name: 'Ada', role: 'user', isActive: true })
    expect(JSON.stringify(user)).not.toContain(GOOD)
    expect(user.passwordHash).toMatch(/^\$argon2id\$/)
  })

  it('normalises the email so casing cannot create a second account', async () => {
    const user = await repo().createUser({ email: '  MiXeD@Example.TEST ', name: 'M', password: GOOD })
    expect(user.email).toBe('mixed@example.test')
  })

  it('refuses a duplicate email', async () => {
    await repo().createUser({ email: 'dup@example.test', name: 'A', password: GOOD })
    await expect(repo().createUser({ email: 'DUP@example.test', name: 'B', password: GOOD })).rejects.toThrow(
      DuplicateEmailError,
    )
  })

  it('enforces the password policy at creation', async () => {
    await expect(repo().createUser({ email: 'w@example.test', name: 'W', password: 'short' })).rejects.toThrow(
      WeakPasswordError,
    )
  })

  it('can create an admin', async () => {
    const user = await repo().createUser({ email: 'root@example.test', name: 'Root', password: GOOD, role: 'admin' })
    expect(user.role).toBe('admin')
  })
})

describe('authenticate', () => {
  beforeEach(async () => {
    await repo().createUser({ email: 'u@example.test', name: 'U', password: GOOD })
  })

  it('returns the user for correct credentials', async () => {
    const user = await repo().authenticate('u@example.test', GOOD)
    expect(user.email).toBe('u@example.test')
  })

  it('accepts a differently-cased email', async () => {
    await expect(repo().authenticate('U@EXAMPLE.TEST', GOOD)).resolves.toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    await expect(repo().authenticate('u@example.test', 'wrong-password-here')).rejects.toThrow(AuthenticationError)
  })

  it('gives the same error for an unknown account, so accounts cannot be enumerated', async () => {
    const unknown = await repo()
      .authenticate('nobody@example.test', GOOD)
      .catch((e) => e)
    const wrong = await repo()
      .authenticate('u@example.test', 'wrong-password-here')
      .catch((e) => e)
    expect(unknown.message).toBe(wrong.message)
    expect(unknown.code).toBe(wrong.code)
  })

  it('records the last login time on success', async () => {
    await repo().authenticate('u@example.test', GOOD)
    const user = await repo().findByEmail('u@example.test')
    expect(user!.lastLoginAt).toBe(now)
  })

  it('counts consecutive failures', async () => {
    await repo().authenticate('u@example.test', 'nope-nope-nope').catch(() => {})
    await repo().authenticate('u@example.test', 'nope-nope-nope').catch(() => {})
    const user = await repo().findByEmail('u@example.test')
    expect(user!.failedLoginCount).toBe(2)
  })

  it('locks the account after too many failures', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await repo().authenticate('u@example.test', 'nope-nope-nope').catch(() => {})
    }
    // Even the right password is refused while the lock stands.
    await expect(repo().authenticate('u@example.test', GOOD)).rejects.toThrow(AccountLockedError)
  })

  it('lets the account back in once the lockout window passes', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await repo().authenticate('u@example.test', 'nope-nope-nope').catch(() => {})
    }
    now += LOCKOUT_MS + 1
    await expect(repo().authenticate('u@example.test', GOOD)).resolves.toBeTruthy()
  })

  it('clears the failure count after a successful login', async () => {
    await repo().authenticate('u@example.test', 'nope-nope-nope').catch(() => {})
    await repo().authenticate('u@example.test', GOOD)
    const user = await repo().findByEmail('u@example.test')
    expect(user!.failedLoginCount).toBe(0)
    expect(user!.lockedUntil).toBeNull()
  })

  it('refuses a deactivated account', async () => {
    const user = await repo().findByEmail('u@example.test')
    await repo().setActive(user!.id, false)
    await expect(repo().authenticate('u@example.test', GOOD)).rejects.toThrow(AccountDisabledError)
  })
})

describe('administration', () => {
  it('lists users without exposing password hashes', async () => {
    await repo().createUser({ email: 'l1@example.test', name: 'A', password: GOOD })
    await repo().createUser({ email: 'l2@example.test', name: 'B', password: GOOD })
    const list = await repo().listUsers()
    expect(list).toHaveLength(2)
    expect(Object.keys(list[0]!)).not.toContain('passwordHash')
  })

  it('changes a password and invalidates the old one', async () => {
    const user = await repo().createUser({ email: 'c@example.test', name: 'C', password: GOOD })
    await repo().changePassword(user.id, 'a-brand-new-long-password')
    await expect(repo().authenticate('c@example.test', GOOD)).rejects.toThrow(AuthenticationError)
    await expect(repo().authenticate('c@example.test', 'a-brand-new-long-password')).resolves.toBeTruthy()
  })

  it('reports whether any account exists, for first-run admin bootstrap', async () => {
    expect(await repo().countUsers()).toBe(0)
    await repo().createUser({ email: 'f@example.test', name: 'F', password: GOOD })
    expect(await repo().countUsers()).toBe(1)
  })

  it('deletes a user', async () => {
    const user = await repo().createUser({ email: 'd@example.test', name: 'D', password: GOOD })
    await repo().deleteUser(user.id)
    expect(await repo().findByEmail('d@example.test')).toBeUndefined()
  })
})
