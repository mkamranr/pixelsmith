import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { auditLog, type AuditEntry } from '../schema.js'

export interface AuditRepoOptions {
  now?: () => number
}

export interface AuditInput {
  userId?: string | null
  action: string
  subject?: string | null
  detail?: unknown
  ip?: string | null
}

/**
 * Append-only record of who did what. Never updated, never deleted from the
 * application — on an isolated network this trail is usually the reason
 * per-user accounts were asked for.
 */
export function auditRepo(db: Db, options: AuditRepoOptions = {}) {
  const now = options.now ?? Date.now

  return {
    async record(entry: AuditInput): Promise<void> {
      db.insert(auditLog)
        .values({
          id: randomUUID(),
          at: now(),
          userId: entry.userId ?? null,
          action: entry.action,
          subject: entry.subject ?? null,
          detail: (entry.detail ?? null) as object | null,
          ip: entry.ip ?? null,
        })
        .run()
    },

    async recent(limit = 200): Promise<AuditEntry[]> {
      return db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(limit).all()
    },

    async forUser(userId: string, limit = 200): Promise<AuditEntry[]> {
      return db.select().from(auditLog).where(eq(auditLog.userId, userId)).orderBy(desc(auditLog.at)).limit(limit).all()
    },
  }
}

export type AuditRepo = ReturnType<typeof auditRepo>
