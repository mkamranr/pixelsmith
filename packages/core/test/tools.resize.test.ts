import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resize } from '../src/tools/resize.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const meta = (p: string) => sharp(p).metadata()

describe('resize tool', () => {
  it('resizes to an exact box when width and height are both given', async () => {
    const src = await fx.writePng(dir, 'exact.png', 100, 50)
    const [out] = await runTool(resize, {
      inputs: [src],
      outDir,
      params: { mode: 'pixels', width: 40, height: 20, fit: 'fill' },
    })
    expect(await meta(out!.path)).toMatchObject({ width: 40, height: 20 })
  })

  it('preserves aspect ratio when only a width is given', async () => {
    const src = await fx.writePng(dir, 'aspect.png', 100, 50)
    const [out] = await runTool(resize, { inputs: [src], outDir, params: { mode: 'pixels', width: 40 } })
    expect(await meta(out!.path)).toMatchObject({ width: 40, height: 20 })
  })

  it('refuses to enlarge when noEnlarge is set, leaving the image at its own size', async () => {
    const src = await fx.writePng(dir, 'small.png', 40, 20)
    const [out] = await runTool(resize, {
      inputs: [src],
      outDir,
      params: { mode: 'pixels', width: 400, noEnlarge: true },
    })
    expect(await meta(out!.path)).toMatchObject({ width: 40, height: 20 })
  })

  it('enlarges when noEnlarge is explicitly disabled', async () => {
    const src = await fx.writePng(dir, 'grow.png', 40, 20)
    const [out] = await runTool(resize, {
      inputs: [src],
      outDir,
      params: { mode: 'pixels', width: 80, noEnlarge: false },
    })
    expect(await meta(out!.path)).toMatchObject({ width: 80, height: 40 })
  })

  it('scales by percentage', async () => {
    const src = await fx.writePng(dir, 'pct.png', 100, 50)
    const [out] = await runTool(resize, { inputs: [src], outDir, params: { mode: 'percent', percent: 25 } })
    expect(await meta(out!.path)).toMatchObject({ width: 25, height: 13 })
  })

  it('keeps the input format, so a PNG stays a PNG', async () => {
    const src = await fx.writePng(dir, 'keep.png', 60, 60)
    const [out] = await runTool(resize, { inputs: [src], outDir, params: { mode: 'pixels', width: 30 } })
    expect((await meta(out!.path)).format).toBe('png')
    expect(out!.name).toBe('keep.png')
    expect(out!.mime).toBe('image/png')
  })

  it('reports the byte size of what it actually wrote', async () => {
    const src = await fx.writePng(dir, 'bytes.png', 80, 80)
    const [out] = await runTool(resize, { inputs: [src], outDir, params: { mode: 'pixels', width: 20 } })
    expect(out!.bytes).toBeGreaterThan(0)
  })

  it('processes a whole batch and returns one output per input', async () => {
    const a = await fx.writePng(dir, 'b1.png', 60, 60)
    const b = await fx.writeJpeg(dir, 'b2.jpg', 60, 60)
    const outs = await runTool(resize, { inputs: [a, b], outDir, params: { mode: 'pixels', width: 30 } })
    expect(outs.map((o) => o.name).sort()).toEqual(['b1.png', 'b2.jpg'])
  })

  it('strips EXIF metadata, so location and camera data never leave with the file', async () => {
    const withExif = join(dir, 'exif.jpg')
    await sharp({ create: { width: 60, height: 60, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'SECRET-MARKER', Artist: 'somebody' } })
      .toFile(withExif)
    expect((await meta(withExif)).exif).toBeDefined()

    const [out] = await runTool(resize, { inputs: [withExif], outDir, params: { mode: 'pixels', width: 30 } })
    expect((await meta(out!.path)).exif).toBeUndefined()
  })

  it('keeps every frame of an animated GIF', async () => {
    const src = await fx.writeAnimatedGif(dir, 'anim-in.gif', 4)
    const [out] = await runTool(resize, { inputs: [src], outDir, params: { mode: 'pixels', width: 8 } })
    expect((await meta(out!.path)).pages).toBe(4)
  })

  it('reports progress across a batch, ending at 1', async () => {
    const a = await fx.writePng(dir, 'p1.png', 40, 40)
    const b = await fx.writePng(dir, 'p2.png', 40, 40)
    const seen: number[] = []
    await runTool(resize, {
      inputs: [a, b],
      outDir,
      params: { mode: 'pixels', width: 10 },
      onProgress: (f) => seen.push(f),
    })
    expect(seen.at(-1)).toBe(1)
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true)
  })

  it('rejects params that name no target dimension at all', () => {
    expect(resize.params.safeParse({ mode: 'pixels' }).success).toBe(false)
  })

  it('rejects a percent mode with no percentage', () => {
    expect(resize.params.safeParse({ mode: 'percent' }).success).toBe(false)
  })
})

describe('output naming', () => {
  it('uses the supplied display name, not the staged filename on disk', async () => {
    // Uploads are stored with an index prefix to keep them unique; that prefix
    // must not follow the user to their download.
    const staged = await fx.writePng(dir, '0-holiday snap.png', 60, 60)
    const [out] = await runTool(resize, {
      inputs: [{ path: staged, name: 'holiday snap.png' }],
      outDir,
      params: { mode: 'pixels', width: 30 },
    })
    expect(out!.name).toBe('holiday snap.png')
  })

  it('falls back to the file basename when no display name is given', async () => {
    const staged = await fx.writePng(dir, 'plain.png', 60, 60)
    const [out] = await runTool(resize, { inputs: [staged], outDir, params: { mode: 'pixels', width: 30 } })
    expect(out!.name).toBe('plain.png')
  })
})
