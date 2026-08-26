import { describe, expect, it } from 'vitest'
import {
  assertPasswordAcceptable,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../src/credentials.js'
import { WeakPasswordError } from '../src/errors.js'

describe('password hashing', () => {
  it('produces a hash that verifies against the original password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false)
  })

  it('uses argon2id', async () => {
    expect(await hashPassword('correct horse battery staple')).toMatch(/^\$argon2id\$/)
  })

  it('salts each hash, so identical passwords do not share a digest', async () => {
    const a = await hashPassword('correct horse battery staple')
    const b = await hashPassword('correct horse battery staple')
    expect(a).not.toBe(b)
  })

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false)
  })
})

describe('password policy', () => {
  it('accepts a sufficiently long password', () => {
    expect(() => assertPasswordAcceptable('a-long-enough-secret')).not.toThrow()
  })

  it('rejects a password below the minimum length', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(WeakPasswordError)
  })

  it('rejects whitespace padding masquerading as length', () => {
    expect(() => assertPasswordAcceptable('a             ')).toThrow(WeakPasswordError)
  })

  it('explains the requirement in the error message', () => {
    expect(() => assertPasswordAcceptable('x')).toThrow(/12/)
  })
})

describe('session tokens', () => {
  it('generates a distinct token every call', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()))
    expect(seen.size).toBe(200)
  })

  it('generates URL-safe tokens with at least 256 bits of entropy', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.length).toBeGreaterThanOrEqual(43)
  })

  it('hashes a token deterministically to 64 hex characters', () => {
    const t = generateToken()
    expect(hashToken(t)).toBe(hashToken(t))
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('maps different tokens to different hashes', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()))
  })
})
