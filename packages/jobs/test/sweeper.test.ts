import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RETENTION_MS } from '@pixelsmith/db'
import { createSweeper } from '../src/sweeper.js'
import { testEnv } from './helpers/env.js'

let env: Awaited<ReturnType<typeof testEnv>>
let now = 1_700_000_000_000

beforeEach(async () => {
  now = 1_700_000_000_000
  env = await testEnv(() => now)
})
afterEach(() => env.cleanup())

const sweeper = () => createSweeper({ jobs: env.jobs, storage: env.storage, now: () => now })

describe('purge sweeper', () => {
  it('leaves a job alone while it is still inside its retention window', async () => {
    const job = await env.jobs.createJob({ userId: env.userId, toolId: 'resize', params: {} })
    await env.storage.prepare(job.id)
    expect(await sweeper().sweep()).toMatchObject({ jobsPurged: 0 })
    expect(await env.storage.listJobDirs()).toContain(job.id)
  })

  it('deletes the files and marks the job expired once retention passes', async () => {
    const job = await env.jobs.createJob({ userId: env.userId, toolId: 'resize', params: {} })
    await env.storage.prepare(job.id)
    now += DEFAULT_RETENTION_MS + 1

    expect(await sweeper().sweep()).toMatchObject({ jobsPurged: 1 })
    expect(await env.storage.listJobDirs()).not.toContain(job.id)
    expect((await env.jobs.getJob(job.id))?.status).toBe('expired')
  })

  it('deletes an orphan directory that has no database row at all', async () => {
    // A crash between mkdir and the insert would leave exactly this behind.
    const orphan = '11111111-2222-4333-8444-555555555555'
    await mkdir(join(env.storage.jobsRoot, orphan), { recursive: true })
    expect(await sweeper().sweep()).toMatchObject({ orphansRemoved: 1 })
    expect(await env.storage.listJobDirs()).not.toContain(orphan)
  })

  it('does not touch a directory belonging to a live job', async () => {
    const job = await env.jobs.createJob({ userId: env.userId, toolId: 'resize', params: {} })
    await env.storage.prepare(job.id)
    await sweeper().sweep()
    expect(await env.storage.listJobDirs()).toContain(job.id)
  })

  it('is safe to run when there is nothing to do', async () => {
    expect(await sweeper().sweep()).toEqual({ jobsPurged: 0, orphansRemoved: 0 })
  })

  it('sweeps repeatedly without re-reporting the same job', async () => {
    const job = await env.jobs.createJob({ userId: env.userId, toolId: 'resize', params: {} })
    await env.storage.prepare(job.id)
    now += DEFAULT_RETENTION_MS + 1
    await sweeper().sweep()
    expect(await sweeper().sweep()).toEqual({ jobsPurged: 0, orphansRemoved: 0 })
  })
})
