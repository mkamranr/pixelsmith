import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registerHandwritingFaces } from '../src/fonts.js'
import { extractPdfText } from '../src/pdf-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
import { editPdf } from '../src/tools/pdf-edit.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let stamp: string
let seq = 0

const FONT_DIR = new URL('../../../assets/vendor/fonts', import.meta.url).pathname

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  // A solid block stands in for a logo: easy to find on a page.
  stamp = join(dir, 'stamp.png')
  await sharp({
    create: { width: 120, height: 60, channels: 4, background: { r: 20, g: 20, b: 90, alpha: 1 } },
  })
    .png()
    .toFile(stamp)
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** Blank pages, so anything found on them was put there by the tool. */
async function blank(name: string, pages = 2): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= pages; page += 1) {
    doc.addPage([400, 600]).drawText(`p${page}`, { x: 8, y: 8, size: 6, font })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], items: unknown[], extra: Record<string, unknown> = {}, assets = {}) =>
  runTool(editPdf, {
    inputs,
    outDir: join(outDir, `e${seq++}`),
    params: { items: JSON.stringify(items), ...extra },
    assets,
    settings: { allowedRenderHosts: [] } as never,
  })

/** Ink in one quarter of a page, so a mark's position can be checked. */
async function quarters(path: string, page = 1) {
  const png = await renderPdfPage(path, page, { scale: 1 })
  const { width = 400, height = 600 } = await sharp(png).metadata()
  const half = { width: Math.floor(width / 2), height: Math.floor(height / 2) }
  const at = async (left: number, top: number) => {
    const strip = await sharp(png).extract({ left, top, ...half }).greyscale().toBuffer()
    return 255 - (await sharp(strip).stats()).channels[0]!.mean
  }
  return {
    topLeft: await at(0, 0),
    topRight: await at(half.width, 0),
    bottomLeft: await at(0, half.height),
    bottomRight: await at(half.width, half.height),
  }
}

describe('editing a page', () => {
  it('writes text where it was placed', async () => {
    const src = await blank('text-here.pdf')

    const [out] = await run([src], [
      { kind: 'text', page: 1, x: 0.1, y: 0.15, text: 'APPROVED', size: 18 },
    ])

    expect((await extractPdfText(out!.path))[0]).toContain('APPROVED')
    const ink = await quarters(out!.path)
    expect(ink.topLeft).toBeGreaterThan(ink.bottomRight)
  })

  it('puts each item on the page it names', async () => {
    const src = await blank('two-pages.pdf')

    const [out] = await run([src], [
      { kind: 'text', page: 2, x: 0.1, y: 0.2, text: 'SECOND', size: 18 },
    ])

    const pages = await extractPdfText(out!.path)
    expect(pages[0]).not.toContain('SECOND')
    expect(pages[1]).toContain('SECOND')
  })

  it('draws several items in one pass', async () => {
    const src = await blank('several.pdf')

    const [out] = await run([src], [
      { kind: 'text', page: 1, x: 0.08, y: 0.1, text: 'TOP LEFT', size: 14 },
      { kind: 'text', page: 1, x: 0.6, y: 0.85, text: 'BOTTOM RIGHT', size: 14 },
    ])

    const ink = await quarters(out!.path)
    expect(ink.topLeft).toBeGreaterThan(0.05)
    expect(ink.bottomRight).toBeGreaterThan(0.05)
    expect((await extractPdfText(out!.path))[0]).toContain('BOTTOM RIGHT')
  })

  it('draws a filled box', async () => {
    const src = await blank('boxed.pdf')

    const [out] = await run([src], [
      { kind: 'box', page: 1, x: 0.05, y: 0.05, width: 0.4, height: 0.3 },
    ])

    const ink = await quarters(out!.path)
    expect(ink.topLeft).toBeGreaterThan(ink.bottomRight + 5)
  })

  it('draws a box as an outline when asked', async () => {
    // A frame round a paragraph, rather than a block over it.
    const src = await blank('outlined.pdf')

    const filled = await run([src], [{ kind: 'box', page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.4 }])
    const outline = await run([src], [
      { kind: 'box', page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.4, outline: true },
    ])

    const solid = await quarters(filled[0]!.path)
    const frame = await quarters(outline[0]!.path)
    expect(frame.topLeft).toBeLessThan(solid.topLeft)
    expect(frame.topLeft).toBeGreaterThan(0.05)
  })

  it('places a supplied picture', async () => {
    const src = await blank('stamped.pdf')

    const [out] = await run(
      [src],
      [{ kind: 'image', page: 1, x: 0.55, y: 0.6, width: 0.3 }],
      {},
      { image: stamp },
    )

    const ink = await quarters(out!.path)
    expect(ink.bottomRight).toBeGreaterThan(ink.topLeft + 2)
  })

  it('says so when a picture is wanted and none was given', async () => {
    const src = await blank('no-picture.pdf')

    await expect(
      run([src], [{ kind: 'image', page: 1, x: 0.1, y: 0.1, width: 0.2 }]),
    ).rejects.toThrow(/picture|image/i)
  })

  it('writes in the colour it was told', async () => {
    const src = await blank('coloured.pdf')

    const [out] = await run([src], [
      { kind: 'box', page: 1, x: 0.1, y: 0.1, width: 0.6, height: 0.5, colour: 'red' },
    ])
    const png = await renderPdfPage(out!.path, 1, { scale: 0.5 })
    const { channels } = await sharp(png).stats()

    expect(channels[0]!.mean).toBeGreaterThan(channels[2]!.mean + 5)
  })

  it('can lay a mark over text without hiding it', async () => {
    // A highlight is the point: see-through, so the words underneath survive.
    const src = await blank('highlight.pdf')

    const solid = await run([src], [
      { kind: 'box', page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.2, colour: 'yellow' },
    ])
    const faint = await run([src], [
      { kind: 'box', page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.2, colour: 'yellow', opacity: 0.35 },
    ])

    const heavy = await quarters(solid[0]!.path)
    const light = await quarters(faint[0]!.path)
    expect(light.topLeft).toBeLessThan(heavy.topLeft)
  })

  it('can write a name in a handwriting face, which is what initialling is', async () => {
    registerHandwritingFaces(FONT_DIR)
    const src = await blank('initialled.pdf')

    const plain = await run([src], [{ kind: 'text', page: 1, x: 0.1, y: 0.2, text: 'KR', size: 20 }])
    const hand = await run([src], [
      { kind: 'text', page: 1, x: 0.1, y: 0.2, text: 'KR', size: 20, face: 'caveat' },
    ])

    const one = await renderPdfPage(plain[0]!.path, 1, { scale: 1 })
    const two = await renderPdfPage(hand[0]!.path, 1, { scale: 1 })
    const diff = await sharp(one).composite([{ input: two, blend: 'difference' }]).png().toBuffer()
    expect((await sharp(diff).stats()).channels[0]!.mean).toBeGreaterThan(0.05)
  })

  it('refuses a page the document does not have', async () => {
    const src = await blank('short.pdf', 2)

    await expect(
      run([src], [{ kind: 'text', page: 9, x: 0.1, y: 0.1, text: 'nowhere' }]),
    ).rejects.toThrow(/page 9|past the end/i)
  })

  it('refuses text with nothing to write', async () => {
    const src = await blank('empty-text.pdf')

    await expect(run([src], [{ kind: 'text', page: 1, x: 0.1, y: 0.1 }])).rejects.toThrow(/words|text/i)
  })

  it('refuses a box with no size', async () => {
    const src = await blank('sizeless.pdf')

    await expect(run([src], [{ kind: 'box', page: 1, x: 0.1, y: 0.1 }])).rejects.toThrow(/size|width/i)
  })

  it('insists on something to draw', async () => {
    expect(editPdf.params.safeParse({ items: '[]' }).success).toBe(false)
    expect(editPdf.params.safeParse({}).success).toBe(false)
    expect(editPdf.params.safeParse({ items: 'not json' }).success).toBe(true) // shape checked in run
  })

  it('leaves the rest of the document alone', async () => {
    const src = await blank('untouched.pdf', 3)

    const [out] = await run([src], [{ kind: 'text', page: 2, x: 0.1, y: 0.2, text: 'ONLY HERE' }])
    const pages = await extractPdfText(out!.path)

    expect(pages).toHaveLength(3)
    expect(pages[0]).toContain('p1')
    expect(pages[2]).toContain('p3')
  })
})
