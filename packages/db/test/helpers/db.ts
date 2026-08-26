import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../src/client.js'
import { migrateDatabase } from '../../src/migrate.js'

const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))

/** A migrated, empty, in-memory database. Fast enough to use per test. */
export function freshDb() {
  const handle = openDatabase(':memory:')
  migrateDatabase(handle.db, MIGRATIONS)
  return handle
}
