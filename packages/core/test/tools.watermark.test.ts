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

  /**
   * Nine positions is nine answers to a question with infinitely many. The PDF
   * watermark has been draggable for a while; this is the image one catching up,
   * and the coordinates are what dragging writes.
   */
  const inkIn = async (buffer: Buffer) =>
    (await sharp(buffer).stats()).channels.reduce((total, c) => total + c.stdev, 0)

  const quadrants = async (path: string) => {
    const image = sharp(path)
    const { width = 400, height = 300 } = await image.metadata()
    const half = { width: Math.floor(width / 2), height: Math.floor(height / 2) }
    const at = async (left: number, top: number) =>
      inkIn(await sharp(path).extract({ left, top, ...half }).toBuffer())
    return {
      topLeft: await at(0, 0),
      topRight: await at(half.width, 0),
      bottomLeft: await at(0, half.height),
      bottomRight: await at(half.width, half.height),
    }
  }

  it('puts the mark at the coordinates it is given', async () => {
    const src = await whiteCanvas('at-xy.png')
    const [out] = await runTool(watermark, {
      inputs: [src],
      outDir: join(outDir, 'xy'),
      // Upper left quarter, nowhere near the default bottom right.
      params: { text: 'HERE', x: 0.22, y: 0.2 },
    })

    const ink = await quadrants(out!.path)

    expect(ink.topLeft).toBeGreaterThan(ink.bottomRight)
    expect(ink.topLeft).toBeGreaterThan(ink.topRight)
  })

  it('moves the mark when the coordinates move', async () => {
    const src = await whiteCanvas('moved.png')
    const one = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'xy-a'), params: { text: 'HERE', x: 0.2, y: 0.2 },
    })
    const two = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'xy-b'), params: { text: 'HERE', x: 0.8, y: 0.8 },
    })

    const first = await quadrants(one[0]!.path)
    const second = await quadrants(two[0]!.path)

    expect(first.topLeft).toBeGreaterThan(first.bottomRight)
    expect(second.bottomRight).toBeGreaterThan(second.topLeft)
  })

  it('still honours the nine positions when given no coordinates', async () => {
    // The presets remain: "bottom right" is a perfectly good way to say it, and
    // an existing caller must not change behaviour.
    const src = await whiteCanvas('preset.png')
    const [out] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'preset'), params: { text: 'HERE', position: 'top-right' },
    })

    const ink = await quadrants(out!.path)

    expect(ink.topRight).toBeGreaterThan(ink.bottomLeft)
  })

  it('refuses coordinates outside the image', () => {
    expect(watermark.params.safeParse({ text: 'x', x: 1.4 }).success).toBe(false)
    expect(watermark.params.safeParse({ text: 'x', y: -0.2 }).success).toBe(false)
  })

  it('rejects an empty watermark', () => {
    expect(watermark.params.safeParse({ text: '   ' }).success).toBe(false)
  })

  it('rejects an opacity outside 1..100', () => {
    expect(watermark.params.safeParse({ text: 'x', opacity: 0 }).success).toBe(false)
    expect(watermark.params.safeParse({ text: 'x', opacity: 101 }).success).toBe(false)
  })
})
