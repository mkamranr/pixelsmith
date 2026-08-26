import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { convert } from '../src/tools/convert.js'
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

/** A PNG that is half transparent, to prove alpha handling. */
async function transparentPng(name: string) {
  const p = join(dir, name)
  await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toFile(p)
  return p
}

describe('convert tool', () => {
  it('turns a PNG into a JPEG', async () => {
    const src = await fx.writePng(dir, 'a.png', 50, 40)
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'jpeg' } })
    expect((await sharp(out!.path).metadata()).format).toBe('jpeg')
    expect(out!.name).toBe('a.jpg')
    expect(out!.mime).toBe('image/jpeg')
  })

  it('flattens transparency onto the chosen background, since JPEG has no alpha', async () => {
    const src = await transparentPng('clear.png')
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'jpeg', background: '#00ff00' } })
    const meta = await sharp(out!.path).metadata()
    expect(meta.hasAlpha).toBe(false)
    const stats = await sharp(out!.path).stats()
    expect(stats.channels[1]!.mean).toBeGreaterThan(200)
  })

  it('keeps transparency when the target format supports it', async () => {
    const src = await transparentPng('clear2.png')
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'webp' } })
    expect((await sharp(out!.path).metadata()).hasAlpha).toBe(true)
  })

  it('turns a JPEG into a PNG', async () => {
    const src = await fx.writeJpeg(dir, 'b.jpg', 30, 30)
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'png' } })
    expect((await sharp(out!.path).metadata()).format).toBe('png')
    expect(out!.name).toBe('b.png')
  })

  it('rasterises an SVG, which is the one input format that is not already pixels', async () => {
    const src = await fx.writePlainSvg(dir, 'vector.svg')
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'png' } })
    expect((await sharp(out!.path).metadata()).format).toBe('png')
  })

  it('refuses an SVG carrying a script, rather than rasterising it', async () => {
    const src = await fx.writeHostileSvg(dir, 'evil.svg')
    await expect(runTool(convert, { inputs: [src], outDir, params: { to: 'png' } })).rejects.toThrow(/svg/i)
  })

  it('keeps every frame when converting an animation to WebP', async () => {
    const src = await fx.writeAnimatedGif(dir, 'anim.gif', 4)
    const [out] = await runTool(convert, { inputs: [src], outDir, params: { to: 'webp' } })
    expect((await sharp(out!.path).metadata()).pages).toBe(4)
  })

  it('converts a batch of mixed input formats to one target', async () => {
    const a = await fx.writePng(dir, 'm1.png', 20, 20)
    const b = await fx.writeTiff(dir, 'm2.tiff', 20, 20)
    const outs = await runTool(convert, { inputs: [a, b], outDir, params: { to: 'webp' } })
    expect(outs.map((o) => o.name).sort()).toEqual(['m1.webp', 'm2.webp'])
  })
})
