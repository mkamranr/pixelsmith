import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rotate } from '../src/tools/rotate.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const meta = (p: string) => sharp(p).metadata()

describe('rotate tool', () => {
  it('swaps width and height at 90 degrees', async () => {
    const src = await fx.writePng(dir, 'r90.png', 100, 50)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 90 } })
    expect(await meta(out!.path)).toMatchObject({ width: 50, height: 100 })
  })

  it('keeps dimensions at 180 degrees', async () => {
    const src = await fx.writePng(dir, 'r180.png', 100, 50)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 180 } })
    expect(await meta(out!.path)).toMatchObject({ width: 100, height: 50 })
  })

  it('grows the canvas for an angle that is not a right angle', async () => {
    const src = await fx.writePng(dir, 'r45.png', 100, 100)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 45 } })
    const m = await meta(out!.path)
    expect(m.width!).toBeGreaterThan(100)
  })

  it('mirrors horizontally', async () => {
    const src = join(dir, 'mirror.png')
    const left = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer()
    await sharp({ create: { width: 40, height: 10, channels: 3, background: '#0000ff' } })
      .composite([{ input: left, left: 0, top: 0 }])
      .png()
      .toFile(src)

    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 0, flop: true } })
    // The red block started on the left; after mirroring the left edge is blue.
    // sharp's stats() reads the *input* image and ignores queued operations, so
    // the region has to be materialised before it can be measured.
    const region = await sharp(out!.path).extract({ left: 0, top: 0, width: 5, height: 10 }).toBuffer()
    const edge = await sharp(region).stats()
    expect(edge.channels[2]!.mean).toBeGreaterThan(200)
    expect(edge.channels[0]!.mean).toBeLessThan(55)
  })

  it('flips vertically', async () => {
    const src = await fx.writePng(dir, 'flip.png', 30, 30)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 0, flip: true } })
    expect(await meta(out!.path)).toMatchObject({ width: 30, height: 30 })
  })

  it('normalises an angle beyond a full turn', async () => {
    const src = await fx.writePng(dir, 'r450.png', 100, 50)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: 450 } })
    expect(await meta(out!.path)).toMatchObject({ width: 50, height: 100 })
  })

  it('handles a negative angle', async () => {
    const src = await fx.writePng(dir, 'rneg.png', 100, 50)
    const [out] = await runTool(rotate, { inputs: [src], outDir, params: { angle: -90 } })
    expect(await meta(out!.path)).toMatchObject({ width: 50, height: 100 })
  })
})
