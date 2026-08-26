import { and, eq, lte } from 'drizzle-orm'
import type { Db } from '../client.js'
import { sessions, users, type Session, type User } from '../schema.js'
import { generateToken, hashToken } from '../credentials.js'

/** How long a signed-in browser stays signed in. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export interface SessionsRepoOptions {
  now?: () => number
}

export interface SessionContext {
  ip?: string | undefined
  userAgent?: string | undefined
  ttlMs?: number
}

export function sessionsRepo(db: Db, options: SessionsRepoOptions = {}) {
  const now = options.now ?? Date.now

  return {
    /**
     * Issue a session. The plaintext token is returned exactly once, here, and
     * only its hash is persisted — a copy of the database grants no sessions.
     */
    async createSession(userId: string, ctx: SessionContext): Promise<{ token: string; expiresAt: number }> {
      const token = generateToken()
      const expiresAt = now() + (ctx.ttlMs ?? SESSION_TTL_MS)
      db.insert(sessions)
        .values({
          tokenHash: hashToken(token),
          userId,
          expiresAt,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          createdAt: now(),
        })
        .run()
      return { token, expiresAt }
    },

    async resolveSession(token: string): Promise<{ session: Session; user: User } | undefined> {
      const session = db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).get()
      if (!session) return undefined

      if (session.expiresAt <= now()) {
        // Opportunistic cleanup: an expired token that gets presented is a free
        // chance to drop the row without waiting for the sweeper.
        db.delete(sessions).where(eq(sessions.tokenHash, session.tokenHash)).run()
        return undefined
      }

      const user = db.select().from(users).where(eq(users.id, session.userId)).get()
      // A deactivated account must lose its existing sessions immediately, not
      // at their natural expiry.
      if (!user || !user.isActive) return undefined

      return { session, user }
    },

    async destroySession(token: string): Promise<void> {
      db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run()
    },

    async destroyAllForUser(userId: string): Promise<void> {
      db.delete(sessions).where(eq(sessions.userId, userId)).run()
    },

    async purgeExpired(): Promise<number> {
      return db.delete(sessions).where(lte(sessions.expiresAt, now())).run().changes
    },

    async listForUser(userId: string): Promise<Session[]> {
      return db.select().from(sessions).where(eq(sessions.userId, userId)).all()
    },
  }
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>
