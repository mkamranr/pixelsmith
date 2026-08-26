import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { watermark } from '../src/tools/watermark.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let logo: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
  // A logo with real transparency, like an actual mark. A fully opaque tile
  // would blend to a single uniform colour when repeated, which measures as
  // zero variation and tells us nothing.
  logo = join(dir, 'logo.png')
  const block = await sharp({
    create: { width: 30, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer()
  await sharp({
    create: { width: 60, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: block, left: 0, top: 0 }])
    .png()
    .toFile(logo)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

async function canvas(name: string, w = 400, h = 300) {
  const p = join(dir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toFile(p)
  return p
}

/** Variation across the image; a flat canvas has none. */
async function ink(path: string): Promise<number> {
  const stats = await sharp(path).stats()
  return stats.channels.reduce((acc, c) => acc + c.stdev, 0)
}

describe('image watermark', () => {
  it('composites a supplied logo onto the image', async () => {
    const src = await canvas('img1.png')
    const before = await ink(src)
    const [out] = await runTool(watermark, {
      inputs: [src],
      outDir: join(outDir, 'a'),
      params: { mark: 'image' },
      assets: { markFile: logo },
    })
    expect(await ink(out!.path)).toBeGreaterThan(before)
  })

  it('leaves the base image dimensions unchanged', async () => {
    const src = await canvas('img2.png', 320, 200)
    const [out] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'b'), params: { mark: 'image' }, assets: { markFile: logo },
    })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 320, height: 200 })
  })

  it('scales the logo relative to the image width', async () => {
    const src = await canvas('img3.png', 400, 300)
    const small = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'small'),
      params: { mark: 'image', markScale: 10 }, assets: { markFile: logo },
    })
    const large = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'large'),
      params: { mark: 'image', markScale: 60 }, assets: { markFile: logo },
    })
    // A bigger logo covers more of a flat canvas, so it varies the image more.
    expect(await ink(large[0]!.path)).toBeGreaterThan(await ink(small[0]!.path))
  })

  it('honours the requested corner', async () => {
    const src = await canvas('img4.png', 400, 300)
    const [out] = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'tl'),
      params: { mark: 'image', position: 'top-left', markScale: 30 }, assets: { markFile: logo },
    })
    const region = async (left: number, top: number) => {
      const buf = await sharp(out!.path).extract({ left, top, width: 120, height: 90 }).toBuffer()
      return (await sharp(buf).stats()).channels[0]!.mean
    }
    // The logo is pure red, so the red channel is far higher where it landed.
    expect(await region(0, 0)).toBeGreaterThan(await region(280, 210))
  })

  it('tiles the logo when asked', async () => {
    const src = await canvas('img5.png', 400, 300)
    const single = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'one'), params: { mark: 'image' }, assets: { markFile: logo },
    })
    const tiled = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'many'), params: { mark: 'image', tiled: true }, assets: { markFile: logo },
    })
    expect(await ink(tiled[0]!.path)).toBeGreaterThan(await ink(single[0]!.path))
  })

  it('applies opacity to the logo', async () => {
    const src = await canvas('img6.png', 400, 300)
    const faint = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'faint'),
      params: { mark: 'image', opacity: 15 }, assets: { markFile: logo },
    })
    const solid = await runTool(watermark, {
      inputs: [src], outDir: join(outDir, 'solid'),
      params: { mark: 'image', opacity: 100 }, assets: { markFile: logo },
    })
    expect(await ink(faint[0]!.path)).toBeLessThan(await ink(solid[0]!.path))
  })

  it('explains itself when image mode is chosen but no logo was supplied', async () => {
    const src = await canvas('img7.png')
    await expect(
      runTool(watermark, { inputs: [src], outDir: join(outDir, 'none'), params: { mark: 'image' } }),
    ).rejects.toThrow(/logo|watermark image/i)
  })

  it('still requires text in text mode', () => {
    expect(watermark.params.safeParse({ mark: 'text' }).success).toBe(false)
    expect(watermark.params.safeParse({ mark: 'text', text: 'OK' }).success).toBe(true)
  })

  it('does not require text in image mode', () => {
    expect(watermark.params.safeParse({ mark: 'image' }).success).toBe(true)
  })
})
