import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Timestamps are epoch milliseconds as integers throughout. SQLite has no date
 * type, and storing numbers keeps comparisons trivial and portable to Postgres
 * if the API tier ever needs replicas.
 */
const createdAt = () =>
  integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now())

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** Password change forced on next login — used for admin-issued credentials. */
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: integer('locked_until'),
    lastLoginAt: integer('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
)

/**
 * Only a hash of the session token is stored. A stolen database copy then
 * yields no usable sessions, which is the whole point of hashing them.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
)

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toolId: text('tool_id').notNull(),
    params: text('params', { mode: 'json' }).notNull(),
    /**
     * Handed back when the job is created, so a client that keeps no cookies
     * can still read its own job. Null on rows created before this existed;
     * those are only readable by their owner's cookie, as they always were.
     */
    readToken: text('read_token'),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'expired', 'cancelled'] })
      .notNull()
      .default('queued'),
    progress: integer('progress').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** When the job's files become eligible for the purge sweeper. */
    expiresAt: integer('expires_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_user_idx').on(t.userId),
    index('jobs_status_idx').on(t.status),
    index('jobs_expiry_idx').on(t.expiresAt),
  ],
)

export const jobFiles = sqliteTable(
  'job_files',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** `asset` is a supporting file, e.g. a watermark logo: not processed itself. */
    role: text('role', { enum: ['input', 'output', 'asset'] }).notNull(),
    name: text('name').notNull(),
    /** Path relative to the job directory — never absolute, never user-supplied. */
    relPath: text('rel_path').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('job_files_job_idx').on(t.jobId)],
)

/**
 * Append-only. On an isolated network the question "who processed what, when"
 * is usually the reason per-user accounts were wanted in the first place.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: createdAt(),
    userId: text('user_id'),
    action: text('action').notNull(),
    subject: text('subject'),
    detail: text('detail', { mode: 'json' }),
    ip: text('ip'),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_user_idx').on(t.userId)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type Job = typeof jobs.$inferSelect
export type JobFile = typeof jobFiles.$inferSelect
export type AuditEntry = typeof auditLog.$inferSelect
