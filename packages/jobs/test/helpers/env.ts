import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateDatabase, openDatabase, usersRepo, jobsRepo } from '@pixelsmith/db'
import { jobStorage } from '../../src/storage.js'

const MIGRATIONS = fileURLToPath(new URL('../../../db/migrations', import.meta.url))

export async function testEnv(now: () => number = Date.now) {
  const root = await mkdtemp(join(tmpdir(), 'pixelsmith-jobs-'))
  const handle = openDatabase(':memory:')
  migrateDatabase(handle.db, MIGRATIONS)

  const users = usersRepo(handle.db, { now })
  const jobs = jobsRepo(handle.db, { now })
  const storage = jobStorage(root)
  const user = await users.createUser({
    email: 'p@example.test',
    name: 'P',
    password: 'a-sufficiently-long-password',
  })

  return {
    root,
    db: handle.db,
    users,
    jobs,
    storage,
    userId: user.id,
    async cleanup() {
      handle.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
