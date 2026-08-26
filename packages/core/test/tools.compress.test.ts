import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compress } from '../src/tools/compress.js'
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

/** A photo-like image: noise compresses realistically, flat colour does not. */
async function noisyJpeg(name: string, w = 600, h = 400) {
  const px = Buffer.alloc(w * h * 3)
  for (let i = 0; i < px.length; i++) px[i] = (i * 7919) % 256
  const p = join(dir, name)
  await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toFile(p)
  return p
}

describe('compress tool', () => {
  it('makes the file smaller', async () => {
    const src = await noisyJpeg('big.jpg')
    const before = (await stat(src)).size
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'balanced' } })
    expect(out!.bytes).toBeLessThan(before)
  })

  it('leaves the dimensions untouched', async () => {
    const src = await noisyJpeg('dims.jpg', 320, 240)
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'strong' } })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 320, height: 240 })
  })

  it('compresses harder at the strong setting than the light one', async () => {
    const src = await noisyJpeg('levels.jpg')
    const [light] = await runTool(compress, { inputs: [src], outDir: join(outDir, 'l'), params: { level: 'light' } })
    const [strong] = await runTool(compress, { inputs: [src], outDir: join(outDir, 's'), params: { level: 'strong' } })
    expect(strong!.bytes).toBeLessThan(light!.bytes)
  })

  it('keeps the original format by default', async () => {
    const src = await fx.writePng(dir, 'keep.png', 200, 200)
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'balanced' } })
    expect((await sharp(out!.path).metadata()).format).toBe('png')
  })

  it('converts to WebP when asked, changing the extension', async () => {
    const src = await noisyJpeg('towebp.jpg', 200, 200)
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'balanced', format: 'webp' } })
    expect((await sharp(out!.path).metadata()).format).toBe('webp')
    expect(out!.name.endsWith('.webp')).toBe(true)
    expect(out!.mime).toBe('image/webp')
  })

  it('hits a requested target size', async () => {
    const src = await noisyJpeg('target.jpg', 800, 600)
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'balanced', targetKb: 40 } })
    expect(out!.bytes).toBeLessThanOrEqual(40 * 1024)
  })

  it('does not bloat a file that is already under the target', async () => {
    const src = await noisyJpeg('small.jpg', 80, 60)
    const before = (await stat(src)).size
    const [out] = await runTool(compress, { inputs: [src], outDir, params: { level: 'balanced', targetKb: 500 } })
    expect(out!.bytes).toBeLessThanOrEqual(before)
  })

  it('rejects a nonsensical target size', () => {
    expect(compress.params.safeParse({ level: 'balanced', targetKb: 0 }).success).toBe(false)
  })
})
