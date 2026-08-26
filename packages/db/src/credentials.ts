import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { MIN_PASSWORD_LENGTH, WeakPasswordError } from './errors.js'

/**
 * Argon2id at roughly the OWASP baseline. Tuned for a CPU-only box that is also
 * busy resizing images: 19 MiB and two passes costs a few tens of milliseconds,
 * which is negligible on a login and expensive in bulk.
 */
const ARGON_OPTS = {
  // Argon2id is the library default; a test pins the $argon2id$ prefix so a
  // change in that default cannot pass unnoticed.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTS)
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, plain)
  } catch {
    // A malformed or truncated hash in the database is a failed login, not a 500.
    return false
  }
}

export function assertPasswordAcceptable(plain: string): void {
  if (plain.trim().length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(`use at least ${MIN_PASSWORD_LENGTH} non-whitespace characters`)
  }
}

/**
 * Session and API tokens are 256 bits of CSPRNG output, so they are hashed with
 * SHA-256 rather than Argon2. Argon2 exists to slow down guessing of
 * low-entropy secrets; against a random 256-bit value there is nothing to
 * guess, and we verify one on every single request.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison for two hex digests of equal length. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
