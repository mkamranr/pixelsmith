import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { meme } from '../src/tools/meme.js'
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

async function grayCanvas(name: string, w = 400, h = 400) {
  const p = join(dir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toFile(p)
  return p
}

/** Spread of pixel values in a strip — text adds strong light/dark contrast. */
async function contrastIn(path: string, top: number, height: number): Promise<number> {
  const strip = await sharp(path).extract({ left: 0, top, width: 400, height }).toBuffer()
  const stats = await sharp(strip).stats()
  return stats.channels[0]!.stdev
}

describe('meme tool', () => {
  it('keeps the canvas the same size', async () => {
    const src = await grayCanvas('size.png')
    const [out] = await runTool(meme, { inputs: [src], outDir, params: { top: 'HELLO', bottom: 'WORLD' } })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 400, height: 400 })
  })

  it('writes the top caption into the top of the image', async () => {
    const src = await grayCanvas('top.png')
    const [out] = await runTool(meme, { inputs: [src], outDir: join(outDir, 't'), params: { top: 'TOP TEXT' } })
    // A flat grey strip has no variation; rendered text introduces plenty.
    expect(await contrastIn(out!.path, 0, 100)).toBeGreaterThan(5)
  })

  it('writes the bottom caption into the bottom of the image', async () => {
    const src = await grayCanvas('bottom.png')
    const [out] = await runTool(meme, { inputs: [src], outDir: join(outDir, 'b'), params: { bottom: 'BOTTOM TEXT' } })
    expect(await contrastIn(out!.path, 300, 100)).toBeGreaterThan(5)
    // and leaves the top alone
    expect(await contrastIn(out!.path, 0, 80)).toBeLessThan(2)
  })

  it('accepts a caption on only one side', async () => {
    const src = await grayCanvas('one.png')
    const [out] = await runTool(meme, { inputs: [src], outDir: join(outDir, 'o'), params: { top: 'ONLY TOP' } })
    expect(out!.bytes).toBeGreaterThan(0)
  })

  it('refuses a meme with no caption at all', () => {
    expect(meme.params.safeParse({}).success).toBe(false)
    expect(meme.params.safeParse({ top: '', bottom: '  ' }).success).toBe(false)
  })

  it('escapes markup in the caption instead of letting it become SVG', async () => {
    const src = await grayCanvas('escape.png')
    const [out] = await runTool(meme, {
      inputs: [src], outDir: join(outDir, 'e'),
      params: { top: '<script>alert(1)</script> & "quotes"' },
    })
    // The point is that it renders as text and does not blow up the SVG parser.
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 400 })
  })
})
