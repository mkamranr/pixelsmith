import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preparePdfText } from '../src/pdf-draw-text.js'
import { extractPdfText } from '../src/pdf-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
import * as fx from './helpers/fixtures.js'

let dir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** Draw one mark on a blank page and hand back the saved file. */
async function pageWith(name: string, text: string, size = 36) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 200])
  const mark = await preparePdfText(doc, { text, size })
  mark.draw(page, { x: 20, y: 80 })
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return { path, mark }
}

/**
 * The darkest pixel in any channel. Blank paper renders as exactly 255
 * everywhere, so anything below that is ink — which is the right test for a
 * coloured, translucent mark, where averaging the red channel of red text
 * barely moves at all.
 */
async function darkestPixel(path: string): Promise<number> {
  const png = await renderPdfPage(path, 1, { scale: 1 })
  const stats = await sharp(png).stats()
  return Math.min(...stats.channels.map((channel) => channel.min))
}

async function inkCoverage(path: string): Promise<number> {
  const png = await renderPdfPage(path, 1, { scale: 1 })
  const stats = await sharp(png).stats()
  // Darker than paper, averaged over the page.
  return (255 - stats.channels[0]!.mean) / 255
}

describe('drawing text into a PDF', () => {
  it('writes Latin text as real, selectable text', async () => {
    const { path } = await pageWith('latin.pdf', 'QUARTERLY')
    expect((await extractPdfText(path))[0]).toContain('QUARTERLY')
  })

  it('writes Arabic without failing, where pdf-lib alone cannot', async () => {
    // pdf-lib's standard fonts throw `WinAnsi cannot encode` on Arabic, and its
    // drawText does no shaping even with a font that has the glyphs, so joined
    // script has to come from a real text engine.
    const { path } = await pageWith('arabic.pdf', 'سري للغاية')
    expect(await inkCoverage(path)).toBeGreaterThan(0.005)
  })

  it('says plainly that shaped text arrives as an image, not as text', async () => {
    // The honest consequence: correct Arabic on the page, but not searchable.
    const { path } = await pageWith('arabic-text.pdf', 'سري للغاية')
    expect((await extractPdfText(path))[0]!.trim()).toBe('')
  })

  it('measures the mark, so a caller can centre or tile it', async () => {
    const short = await preparePdfText(await PDFDocument.create(), { text: 'A', size: 24 })
    const long = await preparePdfText(await PDFDocument.create(), {
      text: 'AAAAAAAAAAAAAAAA',
      size: 24,
    })

    expect(short.width).toBeGreaterThan(0)
    expect(long.width).toBeGreaterThan(short.width * 4)
    expect(short.height).toBeGreaterThan(0)
  })

  it('measures a shaped mark too', async () => {
    const mark = await preparePdfText(await PDFDocument.create(), { text: 'سري للغاية', size: 24 })
    expect(mark.width).toBeGreaterThan(10)
    expect(mark.height).toBeGreaterThan(10)
  })

  it('accepts opacity and rotation on either kind of mark', async () => {
    for (const [name, text] of [['rot-latin.pdf', 'DRAFT'], ['rot-arabic.pdf', 'مسودة']] as const) {
      const doc = await PDFDocument.create()
      const page = doc.addPage([400, 200])
      const mark = await preparePdfText(doc, { text, size: 30, colour: { r: 0.8, g: 0.2, b: 0.1 } })
      mark.draw(page, { x: 40, y: 60, opacity: 0.3, rotate: -30 })
      const path = join(dir, name)
      await writeFile(path, await doc.save())
      expect(await darkestPixel(path)).toBeLessThan(250)
    }
  })
})
