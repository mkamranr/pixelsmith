import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editor, EditRecipe } from '../src/tools/editor.js'
import { STICKERS, stickerById, STICKER_CATEGORIES } from '../src/stickers.js'
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

const run = (src: string, ops: unknown[], extra: Record<string, unknown> = {}) =>
  runTool(editor, {
    inputs: [src],
    outDir: join(outDir, `s${seq++}`),
    params: { recipe: JSON.stringify({ version: 1, ops }), ...extra },
  })

async function grey(name: string, w = 300, h = 200) {
  const p = join(dir, name)
  await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toFile(p)
  return p
}

async function variation(path: string) {
  const stats = await sharp(path).stats()
  return stats.channels.reduce((a, c) => a + c.stdev, 0)
}

describe('sticker catalogue', () => {
  it('offers stickers in named categories', () => {
    expect(STICKER_CATEGORIES.length).toBeGreaterThanOrEqual(4)
    for (const category of STICKER_CATEGORIES) {
      expect(STICKERS.filter((s) => s.category === category.id).length).toBeGreaterThan(0)
    }
  })

  it('gives every sticker a unique id', () => {
    const ids = STICKERS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every sticker drawable geometry', () => {
    for (const sticker of STICKERS) {
      expect(sticker.path.length).toBeGreaterThan(4)
      expect(sticker.viewBox).toMatch(/^[\d.\-]+ [\d.\-]+ [\d.\-]+ [\d.\-]+$/)
    }
  })

  it('looks a sticker up by id, and reports an unknown one', () => {
    expect(stickerById(STICKERS[0]!.id)?.label).toBe(STICKERS[0]!.label)
    expect(stickerById('no-such-sticker')).toBeUndefined()
  })
})

describe('sticker operation', () => {
  it('draws a sticker onto the image', async () => {
    const src = await grey('sticker.png')
    const before = await variation(src)
    const [out] = await run(src, [
      { op: 'sticker', sticker: 'arrow-right', x: 0.5, y: 0.5, size: 0.4, color: '#ff0000' },
    ])
    expect(await variation(out!.path)).toBeGreaterThan(before)
  })

  it('leaves the image dimensions alone', async () => {
    const src = await grey('sticker2.png', 240, 160)
    const [out] = await run(src, [{ op: 'sticker', sticker: 'tick', x: 0.5, y: 0.5, size: 0.3 }])
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 240, height: 160 })
  })

  it('places it where it is told', async () => {
    const src = await grey('sticker3.png', 400, 400)
    const [out] = await run(src, [
      { op: 'sticker', sticker: 'block', x: 0.2, y: 0.2, size: 0.3, color: '#ff0000' },
    ])
    const region = async (left: number, top: number) => {
      const buf = await sharp(out!.path).extract({ left, top, width: 60, height: 60 }).toBuffer()
      return (await sharp(buf).stats()).channels[0]!.mean
    }
    expect(await region(50, 50)).toBeGreaterThan(await region(300, 300))
  })

  it('scales with the size given', async () => {
    const src = await grey('sticker4.png', 400, 400)
    const small = await run(src, [{ op: 'sticker', sticker: 'block', x: 0.5, y: 0.5, size: 0.1, color: '#ff0000' }])
    const large = await run(src, [{ op: 'sticker', sticker: 'block', x: 0.5, y: 0.5, size: 0.6, color: '#ff0000' }])
    expect(await variation(large[0]!.path)).toBeGreaterThan(await variation(small[0]!.path))
  })

  it('rejects a sticker that is not in the catalogue', () => {
    expect(
      EditRecipe.safeParse({
        version: 1,
        ops: [{ op: 'sticker', sticker: 'unicorn', x: 0.5, y: 0.5, size: 0.2 }],
      }).success,
    ).toBe(false)
  })

  it('rejects a size outside the usable range', () => {
    const bad = (size: number) =>
      EditRecipe.safeParse({ version: 1, ops: [{ op: 'sticker', sticker: 'tick', x: 0.5, y: 0.5, size }] }).success
    expect(bad(0)).toBe(false)
    expect(bad(3)).toBe(false)
  })
})

describe('background operation', () => {
  it('fills transparency with the chosen colour', async () => {
    // Rounding the corners makes them transparent; the background then fills them.
    const src = await grey('bg.png', 200, 200)
    const [out] = await run(
      src,
      [{ op: 'corners', radius: 0.4 }, { op: 'background', color: '#00ff00' }],
      { format: 'png' },
    )
    const corner = await sharp(out!.path).extract({ left: 0, top: 0, width: 8, height: 8 }).toBuffer()
    const stats = await sharp(corner).stats()
    expect(stats.channels[1]!.mean).toBeGreaterThan(200)
    // Nothing transparent is left.
    expect((await sharp(out!.path).metadata()).hasAlpha === false || stats.channels[3] === undefined).toBe(true)
  })

  it('leaves an opaque image looking the same', async () => {
    const src = await grey('bg2.png', 120, 120)
    const [out] = await run(src, [{ op: 'background', color: '#ff0000' }])
    const stats = await sharp(out!.path).stats()
    // A fully opaque grey image has nothing for the fill to show through.
    expect(stats.channels[0]!.mean).toBeCloseTo(128, 0)
  })

  it('rejects a colour that is not a hex value', () => {
    expect(EditRecipe.safeParse({ version: 1, ops: [{ op: 'background', color: 'red' }] }).success).toBe(false)
  })
})
