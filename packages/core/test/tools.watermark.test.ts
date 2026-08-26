import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { watermark } from '../src/tools/watermark.js'
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

/**
 * How much ink landed: pixel variation across the image. A flat canvas has
 * none, so any mark raises it — and unlike a distance-from-white measure this
 * works whatever colour the watermark is.
 */
async function inkAmount(path: string): Promise<number> {
  const stats = await sharp(path).stats()
  return stats.channels.reduce((acc, c) => acc + c.stdev, 0)
}

/** Mid-grey, so a white watermark is actually visible against it. */
async function whiteCanvas(name: string, w = 400, h = 300) {
  const p = join(dir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toFile(p)
  return p
}

describe('watermark tool', () => {
  it('leaves the image dimensions unchanged', async () => {
    const src = await whiteCanvas('dims.png')
    const [out] = await runTool(watermark, { inputs: [src], outDir, params: { text: 'CONFIDENTIAL' } })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 400, height: 300 })
  })

  it('actually marks the pixels', async () => {
    const src = await whiteCanvas('marked.png')
    const before = await inkAmount(src)
    const [out] = await runTool(watermark, { inputs: [src], outDir, params: { text: 'CONFIDENTIAL' } })
    expect(await inkAmount(out!.path)).toBeGreaterThan(before)
  })

  it('covers more of the image when tiled than as a single mark', async () => {
    const src = await whiteCanvas('tiled.png')
    const [single] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'one'), params: { text: 'DRAFT', tiled: false },
    })
    const [tiled] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'many'), params: { text: 'DRAFT', tiled: true },
    })
    expect(await inkAmount(tiled!.path)).toBeGreaterThan(await inkAmount(single!.path))
  })

  it('puts a lighter mark down at lower opacity', async () => {
    const src = await whiteCanvas('opacity.png')
    const [faint] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'faint'), params: { text: 'DRAFT', opacity: 15 },
    })
    const [solid] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'solid'), params: { text: 'DRAFT', opacity: 100 },
    })
    expect(await inkAmount(faint!.path)).toBeLessThan(await inkAmount(solid!.path))
  })

  it('places the mark where it is told', async () => {
    const src = await whiteCanvas('placed.png')
    const [out] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'tl'), params: { text: 'HERE', position: 'top-left' },
    })
    const topLeft = await sharp(out!.path).extract({ left: 0, top: 0, width: 200, height: 150 }).toBuffer()
    const bottomRight = await sharp(out!.path).extract({ left: 200, top: 150, width: 200, height: 150 }).toBuffer()
    const inkIn = async (b: Buffer) => (await sharp(b).stats()).channels.reduce((a, c) => a + c.stdev, 0)
    expect(await inkIn(topLeft)).toBeGreaterThan(await inkIn(bottomRight))
  })

  it('rejects an empty watermark', () => {
    expect(watermark.params.safeParse({ text: '   ' }).success).toBe(false)
  })

  it('rejects an opacity outside 1..100', () => {
    expect(watermark.params.safeParse({ text: 'x', opacity: 0 }).success).toBe(false)
    expect(watermark.params.safeParse({ text: 'x', opacity: 101 }).success).toBe(false)
  })
})
