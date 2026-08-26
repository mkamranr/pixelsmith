import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crop } from '../src/tools/crop.js'
import { runTool } from '../src/run.js'
import { LimitExceededError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('crop tool', () => {
  it('cuts out exactly the requested rectangle', async () => {
    const src = await fx.writePng(dir, 'c.png', 200, 100)
    const [out] = await runTool(crop, { inputs: [src], outDir, params: { x: 10, y: 20, width: 50, height: 30 } })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 50, height: 30 })
  })

  it('crops from the correct origin', async () => {
    // Left half red, right half blue: cropping the right half must come out blue.
    const src = join(dir, 'halves.png')
    const left = await sharp({ create: { width: 50, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const right = await sharp({ create: { width: 50, height: 20, channels: 3, background: '#0000ff' } }).png().toBuffer()
    await sharp({ create: { width: 100, height: 20, channels: 3, background: '#000000' } })
      .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 50, top: 0 }])
      .png()
      .toFile(src)

    const [out] = await runTool(crop, { inputs: [src], outDir, params: { x: 50, y: 0, width: 50, height: 20 } })
    const { channels } = await sharp(out!.path).stats()
    expect(channels[2]!.mean).toBeGreaterThan(200)
    expect(channels[0]!.mean).toBeLessThan(55)
  })

  it('refuses a rectangle that runs past the edge of the image', async () => {
    const src = await fx.writePng(dir, 'small.png', 40, 40)
    await expect(
      runTool(crop, { inputs: [src], outDir, params: { x: 20, y: 20, width: 50, height: 50 } }),
    ).rejects.toThrow(LimitExceededError)
  })

  it('applies one rectangle across a whole batch', async () => {
    const a = await fx.writePng(dir, 'b1.png', 100, 100)
    const b = await fx.writePng(dir, 'b2.png', 100, 100)
    const outs = await runTool(crop, { inputs: [a, b], outDir, params: { x: 0, y: 0, width: 40, height: 40 } })
    for (const o of outs) expect(await sharp(o.path).metadata()).toMatchObject({ width: 40, height: 40 })
  })

  it('rejects a zero-sized rectangle', () => {
    expect(crop.params.safeParse({ x: 0, y: 0, width: 0, height: 10 }).success).toBe(false)
  })

  it('rejects a negative origin', () => {
    expect(crop.params.safeParse({ x: -5, y: 0, width: 10, height: 10 }).success).toBe(false)
  })
})
