import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editor, EditRecipe } from '../src/tools/editor.js'
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
/** Recipes arrive from the browser as a JSON string in a form field. */
const recipe = (ops: unknown[]) => ({ recipe: JSON.stringify({ version: 1, ops }) })

describe('edit recipe validation', () => {
  it('accepts an empty operation list', () => {
    expect(EditRecipe.safeParse({ version: 1, ops: [] }).success).toBe(true)
  })

  it('rejects an unknown operation rather than ignoring it', () => {
    // Silently skipping an op the server does not know would hand back an image
    // that differs from the preview the user approved.
    expect(EditRecipe.safeParse({ version: 1, ops: [{ op: 'teleport' }] }).success).toBe(false)
  })

  it('rejects a recipe from a future version it cannot replay faithfully', () => {
    expect(EditRecipe.safeParse({ version: 99, ops: [] }).success).toBe(false)
  })

  it('caps the number of operations, so a recipe cannot grow without bound', () => {
    // The cap is 400 — a freehand session legitimately accumulates many
    // strokes — but it is a cap, and something far beyond it is refused.
    const many = Array.from({ length: 500 }, () => ({ op: 'rotate', angle: 90 }))
    expect(EditRecipe.safeParse({ version: 1, ops: many }).success).toBe(false)

    const allowed = Array.from({ length: 400 }, () => ({ op: 'rotate', angle: 90 }))
    expect(EditRecipe.safeParse({ version: 1, ops: allowed }).success).toBe(true)
  })
})

describe('replaying a recipe at full resolution', () => {
  it('returns the image untouched for an empty recipe', async () => {
    const src = await fx.writePng(dir, 'noop.png', 200, 100)
    const [out] = await runTool(editor, { inputs: [src], outDir, params: recipe([]) })
    expect(await meta(out!.path)).toMatchObject({ width: 200, height: 100 })
  })

  it('applies a crop expressed in fractions of the image, not pixels', async () => {
    // The browser edits a downscaled preview, so it can only speak in
    // proportions; pixel coordinates from a preview would crop the wrong region.
    const src = await fx.writePng(dir, 'crop.png', 400, 200)
    const [out] = await runTool(editor, {
      inputs: [src], outDir,
      params: recipe([{ op: 'crop', x: 0.25, y: 0.5, width: 0.5, height: 0.5 }]),
    })
    expect(await meta(out!.path)).toMatchObject({ width: 200, height: 100 })
  })

  it('applies operations in the order given', async () => {
    const src = await fx.writePng(dir, 'order.png', 400, 200)
    // Rotate then crop the left half: 400x200 -> 200x400 -> 100x400.
    const [out] = await runTool(editor, {
      inputs: [src], outDir,
      params: recipe([
        { op: 'rotate', angle: 90 },
        { op: 'crop', x: 0, y: 0, width: 0.5, height: 1 },
      ]),
    })
    expect(await meta(out!.path)).toMatchObject({ width: 100, height: 400 })
  })

  it('flips and mirrors', async () => {
    const src = await fx.writePng(dir, 'flip.png', 80, 40)
    const [out] = await runTool(editor, {
      inputs: [src], outDir, params: recipe([{ op: 'flip' }, { op: 'flop' }]),
    })
    expect(await meta(out!.path)).toMatchObject({ width: 80, height: 40 })
  })

  it('resizes', async () => {
    const src = await fx.writePng(dir, 'scale.png', 400, 200)
    const [out] = await runTool(editor, {
      inputs: [src], outDir, params: recipe([{ op: 'resize', width: 100 }]),
    })
    expect(await meta(out!.path)).toMatchObject({ width: 100, height: 50 })
  })

  it('adjusts brightness, and the change is visible', async () => {
    const src = join(dir, 'grey.png')
    await sharp({ create: { width: 60, height: 60, channels: 3, background: '#808080' } }).png().toFile(src)

    const [dark] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'dark'), params: recipe([{ op: 'brightness', value: 0.5 }]),
    })
    const [bright] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'bright'), params: recipe([{ op: 'brightness', value: 1.6 }]),
    })

    const mean = async (p: string) => (await sharp(p).stats()).channels[0]!.mean
    expect(await mean(dark!.path)).toBeLessThan(128)
    expect(await mean(bright!.path)).toBeGreaterThan(128)
  })

  it('converts to greyscale', async () => {
    const src = join(dir, 'colour.png')
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#cc3311' } }).png().toFile(src)
    const [out] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'grey'), params: recipe([{ op: 'greyscale' }]),
    })
    const stats = await sharp(out!.path).stats()
    // All channels equal once colour is removed.
    expect(Math.abs(stats.channels[0]!.mean - stats.channels[2]!.mean)).toBeLessThan(1)
  })

  it('draws text at a proportional position', async () => {
    const src = join(dir, 'text.png')
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#222222' } }).png().toFile(src)
    const [out] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'text'),
      params: recipe([{ op: 'text', text: 'STAMPED', x: 0.5, y: 0.5, size: 0.12, color: '#ffffff' }]),
    })
    expect((await sharp(out!.path).stats()).channels[0]!.stdev).toBeGreaterThan(3)
  })

  it('escapes markup inside drawn text', async () => {
    const src = await fx.writePng(dir, 'esc.png', 200, 100)
    const [out] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'esc'),
      params: recipe([{ op: 'text', text: '<script>x</script>', x: 0.5, y: 0.5, size: 0.1 }]),
    })
    expect(await meta(out!.path)).toMatchObject({ width: 200 })
  })

  it('rejects a crop that falls outside the image', async () => {
    const src = await fx.writePng(dir, 'oob.png', 100, 100)
    await expect(
      runTool(editor, {
        inputs: [src], outDir, params: recipe([{ op: 'crop', x: 0.9, y: 0.9, width: 0.5, height: 0.5 }]),
      }),
    ).rejects.toThrow()
  })

  it('rejects a malformed recipe string', async () => {
    const src = await fx.writePng(dir, 'bad.png', 100, 100)
    await expect(
      runTool(editor, { inputs: [src], outDir, params: { recipe: 'not json at all' } }),
    ).rejects.toThrow()
  })

  it('can output a different format than it received', async () => {
    const src = await fx.writePng(dir, 'fmt.png', 80, 80)
    const [out] = await runTool(editor, {
      inputs: [src], outDir: join(outDir, 'fmt'),
      params: { recipe: JSON.stringify({ version: 1, ops: [] }), format: 'jpeg' },
    })
    expect((await meta(out!.path)).format).toBe('jpeg')
    expect(out!.name).toBe('fmt.jpg')
  })
})
