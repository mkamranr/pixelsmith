import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { jobsRepo, DEFAULT_RETENTION_MS } from '../src/repos/jobs.js'
import { usersRepo } from '../src/repos/users.js'
import { freshDb } from './helpers/db.js'

let handle: ReturnType<typeof freshDb>
let now = 1_700_000_000_000
const clock = () => now
let userId: string
let otherUserId: string

beforeEach(async () => {
  handle = freshDb()
  now = 1_700_000_000_000
  const users = usersRepo(handle.db, { now: clock })
  userId = (await users.createUser({ email: 'j@example.test', name: 'J', password: 'a-sufficiently-long-password' })).id
  otherUserId = (await users.createUser({ email: 'k@example.test', name: 'K', password: 'a-sufficiently-long-password' })).id
})
afterEach(() => handle.close())

const repo = () => jobsRepo(handle.db, { now: clock })

const newJob = () => repo().createJob({ userId, toolId: 'resize', params: { width: 100 } })

describe('createJob', () => {
  it('starts a job queued, with no progress', async () => {
    const job = await newJob()
    expect(job).toMatchObject({ status: 'queued', progress: 0, toolId: 'resize' })
  })

  it('round-trips the tool params as JSON', async () => {
    const job = await newJob()
    expect((await repo().getJob(job.id))?.params).toEqual({ width: 100 })
  })

  it('gives even an abandoned queued job an expiry, so nothing lingers forever', async () => {
    const job = await newJob()
    expect(job.expiresAt).toBe(now + DEFAULT_RETENTION_MS)
  })
})

describe('lifecycle', () => {
  it('records the start time when work begins', async () => {
    const job = await newJob()
    now += 1000
    await repo().markRunning(job.id)
    const updated = await repo().getJob(job.id)
    expect(updated).toMatchObject({ status: 'running', startedAt: now })
  })

  it('tracks progress as a percentage', async () => {
    const job = await newJob()
    await repo().updateProgress(job.id, 42)
    expect((await repo().getJob(job.id))?.progress).toBe(42)
  })

  it('clamps progress into 0..100 rather than trusting the caller', async () => {
    const job = await newJob()
    await repo().updateProgress(job.id, 999)
    expect((await repo().getJob(job.id))?.progress).toBe(100)
    await repo().updateProgress(job.id, -5)
    expect((await repo().getJob(job.id))?.progress).toBe(0)
  })

  it('marks a job done with full progress', async () => {
    const job = await newJob()
    await repo().markDone(job.id)
    expect(await repo().getJob(job.id)).toMatchObject({ status: 'done', progress: 100, finishedAt: now })
  })

  it('restarts the retention clock when the job finishes, not when it was queued', async () => {
    const job = await newJob()
    now += 60_000
    await repo().markDone(job.id)
    expect((await repo().getJob(job.id))?.expiresAt).toBe(now + DEFAULT_RETENTION_MS)
  })

  it('records a failure with its code and message', async () => {
    const job = await newJob()
    await repo().markFailed(job.id, 'unsupported_input', 'cannot read image/tiff')
    expect(await repo().getJob(job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'unsupported_input',
      errorMessage: 'cannot read image/tiff',
    })
  })
})

describe('files', () => {
  it('attaches inputs and outputs and reads them back by role', async () => {
    const job = await newJob()
    await repo().addFiles(job.id, [
      { role: 'input', name: 'a.png', relPath: 'in/a.png', mime: 'image/png', bytes: 10 },
      { role: 'output', name: 'a.png', relPath: 'out/a.png', mime: 'image/png', bytes: 5 },
    ])
    const files = await repo().listFiles(job.id)
    expect(files.filter((f) => f.role === 'input').map((f) => f.name)).toEqual(['a.png'])
    expect(files.filter((f) => f.role === 'output').map((f) => f.relPath)).toEqual(['out/a.png'])
  })

  it('removes a job together with its files', async () => {
    const job = await newJob()
    await repo().addFiles(job.id, [{ role: 'input', name: 'a.png', relPath: 'in/a.png', mime: 'image/png', bytes: 10 }])
    await repo().deleteJob(job.id)
    expect(await repo().listFiles(job.id)).toEqual([])
  })
})

describe('ownership', () => {
  it('hands a job to its owner', async () => {
    const job = await newJob()
    expect(await repo().getJobForUser(job.id, userId)).toBeTruthy()
  })

  it('refuses to hand a job to anyone else, so ids cannot be guessed into data', async () => {
    const job = await newJob()
    expect(await repo().getJobForUser(job.id, otherUserId)).toBeUndefined()
  })

  it('lists only the requesting user’s own jobs, newest first', async () => {
    const first = await newJob()
    now += 1000
    const second = await newJob()
    await repo().createJob({ userId: otherUserId, toolId: 'resize', params: {} })
    const mine = await repo().listJobsForUser(userId)
    expect(mine.map((j) => j.id)).toEqual([second.id, first.id])
  })
})

describe('purge sweeper', () => {
  it('finds jobs whose retention window has passed', async () => {
    const job = await newJob()
    expect(await repo().findExpired()).toEqual([])
    now += DEFAULT_RETENTION_MS + 1
    expect((await repo().findExpired()).map((j) => j.id)).toEqual([job.id])
  })

  it('does not return a job it has already marked expired, so the sweeper cannot loop', async () => {
    const job = await newJob()
    now += DEFAULT_RETENTION_MS + 1
    await repo().markExpired(job.id)
    expect(await repo().findExpired()).toEqual([])
    expect((await repo().getJob(job.id))?.status).toBe('expired')
  })
})
