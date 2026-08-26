import Database, { type Database as SqliteDatabase } from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  db: Db
  sqlite: SqliteDatabase
  close(): void
}

/**
 * Open the database with the pragmas this app actually needs:
 * - WAL so a reader (the API serving a page) never blocks a writer.
 * - foreign_keys ON, because SQLite disables them per-connection by default and
 *   the cascade deletes on sessions/job files depend on them.
 * - busy_timeout so a concurrent write waits briefly instead of throwing.
 */
export function openDatabase(path: string): DatabaseHandle {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')

  const db = drizzle(sqlite, { schema })
  return { db, sqlite, close: () => sqlite.close() }
}
