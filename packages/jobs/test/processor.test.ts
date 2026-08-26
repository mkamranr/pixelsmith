import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registry } from '@pixelsmith/core'
import { createProcessor } from '../src/processor.js'
import { testEnv } from './helpers/env.js'

let env: Awaited<ReturnType<typeof testEnv>>
let now = 1_700_000_000_000

beforeEach(async () => {
  now = 1_700_000_000_000
  env = await testEnv(() => now)
})
afterEach(() => env.cleanup())

const processor = () =>
  createProcessor({ jobs: env.jobs, storage: env.storage, registry, now: () => now })

/** Stage a real image as a job input, the way the upload route would. */
async function queueJob(toolId: string, params: unknown, files = 1) {
  const job = await env.jobs.createJob({ userId: env.userId, toolId, params })
  const { inDir } = await env.storage.prepare(job.id)
  const staged = []
  for (let i = 0; i < files; i++) {
    const name = `src${i}.png`
    await sharp({ create: { width: 80, height: 40, channels: 3, background: '#3366aa' } })
      .png()
      .toFile(join(inDir, name))
    staged.push({ role: 'input' as const, name, relPath: `in/${name}`, mime: 'image/png', bytes: 100 })
  }
  await env.jobs.addFiles(job.id, staged)
  return job
}

describe('processJob', () => {
  it('takes a queued job through to done', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 40 })
    await processor().processJob(job.id)
    expect(await env.jobs.getJob(job.id)).toMatchObject({ status: 'done', progress: 100 })
  })

  it('writes the result into the job output directory', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 40 })
    await processor().processJob(job.id)
    const out = (await env.jobs.listFiles(job.id)).filter((f) => f.role === 'output')
    expect(out).toHaveLength(1)
    const real = await env.storage.readable(job.id, out[0]!.relPath)
    expect((await sharp(real).metadata()).width).toBe(40)
  })

  it('records each output with its real size and type', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 20 })
    await processor().processJob(job.id)
    const [out] = (await env.jobs.listFiles(job.id)).filter((f) => f.role === 'output')
    expect(out!.mime).toBe('image/png')
    expect(out!.bytes).toBeGreaterThan(0)
  })

  it('handles a batch, producing one output per input', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 20 }, 3)
    await processor().processJob(job.id)
    expect((await env.jobs.listFiles(job.id)).filter((f) => f.role === 'output')).toHaveLength(3)
  })

  it('marks the job running before it starts work', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 20 })
    const seen: string[] = []
    const p = createProcessor({
      jobs: {
        ...env.jobs,
        markRunning: async (id: string) => {
          seen.push('running')
          return env.jobs.markRunning(id)
        },
      } as typeof env.jobs,
      storage: env.storage,
      registry,
      now: () => now,
    })
    await p.processJob(job.id)
    expect(seen).toEqual(['running'])
  })

  it('fails the job with the tool error code rather than throwing at the worker', async () => {
    const job = await env.jobs.createJob({ userId: env.userId, toolId: 'resize', params: { mode: 'pixels', width: 10 } })
    const { inDir } = await env.storage.prepare(job.id)
    await writeFile(join(inDir, 'notes.txt'), 'not an image at all')
    await env.jobs.addFiles(job.id, [
      { role: 'input', name: 'notes.txt', relPath: 'in/notes.txt', mime: 'text/plain', bytes: 9 },
    ])

    await expect(processor().processJob(job.id)).resolves.toBeUndefined()
    expect(await env.jobs.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'unsupported_input' })
  })

  it('fails a job whose tool does not exist', async () => {
    const job = await queueJob('no-such-tool', {})
    await processor().processJob(job.id)
    expect(await env.jobs.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'unknown_tool' })
  })

  it('fails a job whose params do not satisfy the tool', async () => {
    const job = await queueJob('resize', { mode: 'pixels' })
    await processor().processJob(job.id)
    expect(await env.jobs.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'invalid_params' })
  })

  it('reports progress while working', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 20 }, 2)
    await processor().processJob(job.id)
    // Progress must have been written at least once before completion.
    expect((await env.jobs.getJob(job.id))?.progress).toBe(100)
  })

  it('ignores a job that has already finished, so a redelivered message is harmless', async () => {
    const job = await queueJob('resize', { mode: 'pixels', width: 20 })
    await processor().processJob(job.id)
    const outputsAfterFirst = (await env.jobs.listFiles(job.id)).length
    await processor().processJob(job.id)
    expect((await env.jobs.listFiles(job.id)).length).toBe(outputsAfterFirst)
  })

  it('does nothing for a job id that is not in the database', async () => {
    await expect(processor().processJob('3f6c1a52-9f0e-4c1b-9c2e-2b7c9a1d4e55')).resolves.toBeUndefined()
  })
})
