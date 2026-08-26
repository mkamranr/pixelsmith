import { randomUUID } from 'node:crypto'
import { count, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { users, type User } from '../schema.js'
import { assertPasswordAcceptable, hashPassword, verifyPassword } from '../credentials.js'
import {
  AccountDisabledError,
  AccountLockedError,
  AuthenticationError,
  DuplicateEmailError,
} from '../errors.js'

/** Failed attempts tolerated before the account is temporarily locked. */
export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_MS = 15 * 60 * 1000

/** A user as it may be sent to a client: no credential material. */
export type PublicUser = Omit<User, 'passwordHash'>

export interface UsersRepoOptions {
  /** Injectable clock. Lets lockout expiry be tested without sleeping. */
  now?: () => number
}

export interface CreateUserInput {
  email: string
  name: string
  password: string
  role?: 'admin' | 'user'
  mustChangePassword?: boolean
}

const normaliseEmail = (email: string) => email.trim().toLowerCase()

const PUBLIC_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  failedLoginCount: users.failedLoginCount,
  lockedUntil: users.lockedUntil,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
} as const

function isUniqueViolation(err: unknown): boolean {
  return typeof (err as { code?: string })?.code === 'string' && (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
}

export function usersRepo(db: Db, options: UsersRepoOptions = {}) {
  const now = options.now ?? Date.now

  const findByEmail = async (email: string): Promise<User | undefined> =>
    db.select().from(users).where(eq(users.email, normaliseEmail(email))).get()

  const findById = async (id: string): Promise<User | undefined> =>
    db.select().from(users).where(eq(users.id, id)).get()

  return {
    findByEmail,
    findById,

    async createUser(input: CreateUserInput): Promise<User> {
      assertPasswordAcceptable(input.password)
      const row = {
        id: randomUUID(),
        email: normaliseEmail(input.email),
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        role: input.role ?? 'user',
        isActive: true,
        mustChangePassword: input.mustChangePassword ?? false,
        createdAt: now(),
      }
      try {
        return db.insert(users).values(row).returning().get()
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateEmailError(row.email)
        throw err
      }
    },

    /**
     * Verify credentials, applying lockout.
     *
     * An unknown email costs the same Argon2 work as a known one — we hash the
     * supplied password and throw it away — so response timing does not reveal
     * which accounts exist.
     */
    async authenticate(email: string, password: string): Promise<User> {
      const user = await findByEmail(email)
      if (!user) {
        await hashPassword(password)
        throw new AuthenticationError()
      }

      if (user.lockedUntil !== null && user.lockedUntil > now()) {
        throw new AccountLockedError(user.lockedUntil)
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        const failed = user.failedLoginCount + 1
        const lock = failed >= MAX_FAILED_ATTEMPTS
        db.update(users)
          .set({ failedLoginCount: failed, lockedUntil: lock ? now() + LOCKOUT_MS : null })
          .where(eq(users.id, user.id))
          .run()
        throw new AuthenticationError()
      }

      // Password is correct: only now is it safe to say the account is disabled,
      // since a guesser learns nothing they did not already prove they knew.
      if (!user.isActive) throw new AccountDisabledError()

      db.update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now() })
        .where(eq(users.id, user.id))
        .run()

      return { ...user, failedLoginCount: 0, lockedUntil: null, lastLoginAt: now() }
    },

    async listUsers(): Promise<PublicUser[]> {
      return db.select(PUBLIC_COLUMNS).from(users).orderBy(users.email).all()
    },

    async countUsers(): Promise<number> {
      return db.select({ n: count() }).from(users).get()?.n ?? 0
    },

    async changePassword(id: string, newPassword: string): Promise<void> {
      assertPasswordAcceptable(newPassword)
      db.update(users)
        .set({
          passwordHash: await hashPassword(newPassword),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, id))
        .run()
    },

    async setActive(id: string, isActive: boolean): Promise<void> {
      db.update(users).set({ isActive }).where(eq(users.id, id)).run()
    },

    async setRole(id: string, role: 'admin' | 'user'): Promise<void> {
      db.update(users).set({ role }).where(eq(users.id, id)).run()
    },

    async deleteUser(id: string): Promise<void> {
      db.delete(users).where(eq(users.id, id)).run()
    },
  }
}

export type UsersRepo = ReturnType<typeof usersRepo>
