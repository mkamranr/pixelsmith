import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editor, EditRecipe } from '../src/tools/editor.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** Each run gets its own directory: the editor reuses the input filename. */
const run = (src: string, ops: unknown[], extra: Record<string, unknown> = {}) =>
  runTool(editor, {
    inputs: [src],
    outDir: join(outDir, `r${seq++}`),
    params: { recipe: JSON.stringify({ version: 1, ops }), ...extra },
  })

async function grey(name: string, w = 300, h = 200) {
  const p = join(dir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toFile(p)
  return p
}

/** Mean of one channel over a region, to prove ink landed where intended. */
async function channelIn(path: string, ch: number, left: number, top: number, w = 40, h = 40) {
  const buf = await sharp(path).extract({ left, top, width: w, height: h }).toBuffer()
  return (await sharp(buf).stats()).channels[ch]!.mean
}

describe('shape operations', () => {
  it('draws a filled rectangle where it is told', async () => {
    const src = await grey('rect.png')
    const [out] = await run(src, [
      { op: 'shape', shape: 'rect', x: 0.1, y: 0.1, width: 0.3, height: 0.3, color: '#ff0000', fill: true },
    ])
    // Red channel is high inside the rectangle, unchanged outside it.
    expect(await channelIn(out!.path, 0, 40, 30)).toBeGreaterThan(200)
    expect(await channelIn(out!.path, 0, 240, 150)).toBeLessThan(150)
  })

  it('draws an outlined rectangle, leaving the middle untouched', async () => {
    const src = await grey('outline.png')
    const [out] = await run(src, [
      { op: 'shape', shape: 'rect', x: 0.1, y: 0.1, width: 0.8, height: 0.8, color: '#ff0000', fill: false },
    ])
    // The centre of an unfilled rectangle stays grey.
    expect(await channelIn(out!.path, 0, 130, 80)).toBeLessThan(150)
  })

  it('draws an ellipse', async () => {
    const src = await grey('ellipse.png')
    const [out] = await run(src, [
      { op: 'shape', shape: 'ellipse', x: 0.25, y: 0.25, width: 0.5, height: 0.5, color: '#00ff00', fill: true },
    ])
    expect(await channelIn(out!.path, 1, 130, 80)).toBeGreaterThan(200)
  })

  it('draws a line', async () => {
    const src = await grey('line.png')
    const [out] = await run(src, [
      { op: 'shape', shape: 'line', x: 0, y: 0.5, width: 1, height: 0, color: '#0000ff', strokeWidth: 0.06 },
    ])
    expect(await channelIn(out!.path, 2, 130, 90, 40, 20)).toBeGreaterThan(140)
  })

  it('rejects a shape that is not one of the supported kinds', () => {
    expect(
      EditRecipe.safeParse({
        version: 1,
        ops: [{ op: 'shape', shape: 'hexagon', x: 0, y: 0, width: 1, height: 1, color: '#000000' }],
      }).success,
    ).toBe(false)
  })
})

describe('freehand drawing', () => {
  it('renders a stroked path through the given points', async () => {
    const src = await grey('draw.png')
    const [out] = await run(src, [
      {
        op: 'draw',
        color: '#ff0000',
        width: 0.05,
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.5, y: 0.5 },
          { x: 0.9, y: 0.5 },
        ],
      },
    ])
    expect(await channelIn(out!.path, 0, 130, 90, 40, 20)).toBeGreaterThan(150)
  })

  it('rejects a path with fewer than two points, which cannot be drawn', () => {
    expect(
      EditRecipe.safeParse({ version: 1, ops: [{ op: 'draw', points: [{ x: 0.5, y: 0.5 }], color: '#000000', width: 0.02 }] })
        .success,
    ).toBe(false)
  })

  it('caps the number of points, so a recipe cannot grow without bound', () => {
    const points = Array.from({ length: 6000 }, (_, i) => ({ x: (i % 100) / 100, y: 0.5 }))
    expect(EditRecipe.safeParse({ version: 1, ops: [{ op: 'draw', points, color: '#000000', width: 0.02 }] }).success).toBe(false)
  })
})

describe('frame and corners', () => {
  it('draws a border inside the image without changing its size', async () => {
    const src = await grey('frame.png', 200, 200)
    const [out] = await run(src, [{ op: 'frame', width: 0.08, color: '#ffffff' }])
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 200, height: 200 })
    // The edge is now white; the middle is untouched.
    expect(await channelIn(out!.path, 0, 0, 0, 10, 10)).toBeGreaterThan(220)
    expect(await channelIn(out!.path, 0, 90, 90, 20, 20)).toBeLessThan(150)
  })

  it('rounds the corners, leaving them transparent', async () => {
    const src = await grey('corners.png', 200, 200)
    const [out] = await run(src, [{ op: 'corners', radius: 0.3 }], { format: 'png' })
    const meta = await sharp(out!.path).metadata()
    expect(meta.hasAlpha).toBe(true)

    // Sample the extreme corner: it should now be fully transparent.
    const corner = await sharp(out!.path).extract({ left: 0, top: 0, width: 6, height: 6 }).ensureAlpha().toBuffer()
    const alpha = (await sharp(corner).stats()).channels[3]!.mean
    expect(alpha).toBeLessThan(40)
  })

  it('keeps the centre opaque when rounding corners', async () => {
    const src = await grey('corners2.png', 200, 200)
    const [out] = await run(src, [{ op: 'corners', radius: 0.25 }], { format: 'png' })
    const middle = await sharp(out!.path).extract({ left: 90, top: 90, width: 20, height: 20 }).ensureAlpha().toBuffer()
    expect((await sharp(middle).stats()).channels[3]!.mean).toBeGreaterThan(250)
  })
})

describe('filter presets', () => {
  it('removes colour for the mono preset', async () => {
    const src = join(dir, 'colour.png')
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#cc3311' } }).png().toFile(src)
    const [out] = await run(src, [{ op: 'filter', preset: 'mono' }])
    const stats = await sharp(out!.path).stats()
    expect(Math.abs(stats.channels[0]!.mean - stats.channels[2]!.mean)).toBeLessThan(2)
  })

  it('warms the image for the warm preset', async () => {
    const src = await grey('warm.png', 80, 80)
    const [out] = await run(src, [{ op: 'filter', preset: 'warm' }])
    const stats = await sharp(out!.path).stats()
    // Warming raises red relative to blue.
    expect(stats.channels[0]!.mean).toBeGreaterThan(stats.channels[2]!.mean)
  })

  it('cools the image for the cool preset', async () => {
    const src = await grey('cool.png', 80, 80)
    const [out] = await run(src, [{ op: 'filter', preset: 'cool' }])
    const stats = await sharp(out!.path).stats()
    expect(stats.channels[2]!.mean).toBeGreaterThan(stats.channels[0]!.mean)
  })

  it('leaves the image alone for the none preset', async () => {
    const src = await grey('none.png', 80, 80)
    const [out] = await run(src, [{ op: 'filter', preset: 'none' }])
    const stats = await sharp(out!.path).stats()
    expect(stats.channels[0]!.mean).toBeCloseTo(128, 0)
  })

  it('rejects an unknown preset', () => {
    expect(EditRecipe.safeParse({ version: 1, ops: [{ op: 'filter', preset: 'nashville' }] }).success).toBe(false)
  })
})

describe('a full editing session', () => {
  it('replays a long recipe of mixed operations in order', async () => {
    const src = await grey('session.png', 400, 300)
    const [out] = await run(
      src,
      [
        { op: 'rotate', angle: 90 },
        { op: 'crop', x: 0, y: 0, width: 1, height: 0.5 },
        { op: 'filter', preset: 'warm' },
        { op: 'brightness', value: 1.1 },
        { op: 'shape', shape: 'ellipse', x: 0.3, y: 0.3, width: 0.4, height: 0.4, color: '#00ff00', fill: true },
        { op: 'text', text: 'FINAL', x: 0.5, y: 0.85, size: 0.08, color: '#ffffff' },
        { op: 'frame', width: 0.03, color: '#000000' },
        { op: 'corners', radius: 0.05 },
      ],
      { format: 'png' },
    )
    // 400x300 -> rotate 90 -> 300x400 -> crop top half -> 300x200.
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 300, height: 200 })
  })
})
