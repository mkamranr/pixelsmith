import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { Db } from './client.js'

/**
 * Migrations are generated SQL committed to the repo, not codegen run at deploy
 * time. The isolated server has no toolchain and no network; it only replays
 * files that were reviewed here.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

export function migrateDatabase(db: Db, migrationsFolder: string = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder })
}
