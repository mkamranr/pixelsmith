import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfPageNumbers } from '../src/tools/pdf-page-numbers.js'
import { pdfWatermark } from '../src/tools/pdf-watermark.js'
import { pdfCrop } from '../src/tools/pdf-crop.js'
import { imagesToPdf } from '../src/tools/pdf-from-images.js'
import { runTool } from '../src/run.js'
import { inkInRegion } from './helpers/pdfink.js'
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

/** Blank white pages, so anything drawn on them is unambiguous. */
async function blankPdf(name: string, pages = 2) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([400, 560])
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (tool: Parameters<typeof runTool>[0], inputs: string[], params: unknown = {}) =>
  runTool(tool, { inputs, outDir: join(outDir, `r${seq++}`), params })

const FOOTER = { x: 0.1, y: 0.88, width: 0.8, height: 0.1 }
const HEADER = { x: 0.1, y: 0.02, width: 0.8, height: 0.1 }
const MIDDLE = { x: 0.15, y: 0.4, width: 0.7, height: 0.2 }

describe('page numbers', () => {
  it('draws a number in the footer, where there was nothing', async () => {
    const src = await blankPdf('pn.pdf', 2)
    expect(await inkInRegion(src, 1, FOOTER)).toBeLessThan(1)

    const [out] = await run(pdfPageNumbers, [src])
    expect(await inkInRegion(out!.path, 1, FOOTER)).toBeGreaterThan(3)
  })

  it('numbers every page', async () => {
    const src = await blankPdf('pn-all.pdf', 3)
    const [out] = await run(pdfPageNumbers, [src])
    for (const page of [1, 2, 3]) {
      expect(await inkInRegion(out!.path, page, FOOTER)).toBeGreaterThan(3)
    }
  })

  it('can put the number at the top instead', async () => {
    const src = await blankPdf('pn-top.pdf', 1)
    const [out] = await run(pdfPageNumbers, [src], { position: 'top-center' })
    expect(await inkInRegion(out!.path, 1, HEADER)).toBeGreaterThan(3)
    expect(await inkInRegion(out!.path, 1, FOOTER)).toBeLessThan(1)
  })

  it('leaves pages outside the selection untouched', async () => {
    const src = await blankPdf('pn-some.pdf', 3)
    const [out] = await run(pdfPageNumbers, [src], { pages: '2' })
    expect(await inkInRegion(out!.path, 1, FOOTER)).toBeLessThan(1)
    expect(await inkInRegion(out!.path, 2, FOOTER)).toBeGreaterThan(3)
  })

  it('keeps the page count and page size unchanged', async () => {
    const src = await blankPdf('pn-size.pdf', 2)
    const [out] = await run(pdfPageNumbers, [src])
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    expect(doc.getPageCount()).toBe(2)
    expect(Math.round(doc.getPage(0).getSize().width)).toBe(400)
  })

  it('starts counting where it is told', () => {
    expect(pdfPageNumbers.params.safeParse({ startAt: 0 }).success).toBe(false)
    expect(pdfPageNumbers.params.safeParse({ startAt: 7 }).success).toBe(true)
  })
})

describe('watermark a PDF', () => {
  it('marks the page', async () => {
    const src = await blankPdf('wm.pdf', 1)
    const [out] = await run(pdfWatermark, [src], { text: 'DRAFT' })
    expect(await inkInRegion(out!.path, 1, MIDDLE)).toBeGreaterThan(2)
  })

  it('marks every page', async () => {
    const src = await blankPdf('wm-all.pdf', 2)
    const [out] = await run(pdfWatermark, [src], { text: 'RESTRICTED' })
    expect(await inkInRegion(out!.path, 2, MIDDLE)).toBeGreaterThan(2)
  })

  it('lays down less ink at a lower opacity', async () => {
    const src = await blankPdf('wm-op.pdf', 1)
    const faint = await run(pdfWatermark, [src], { text: 'DRAFT', opacity: 10 })
    const solid = await run(pdfWatermark, [src], { text: 'DRAFT', opacity: 100 })
    expect(await inkInRegion(faint[0]!.path, 1, MIDDLE)).toBeLessThan(
      await inkInRegion(solid[0]!.path, 1, MIDDLE),
    )
  })

  it('covers more of the page when tiled', async () => {
    const src = await blankPdf('wm-tile.pdf', 1)
    const single = await run(pdfWatermark, [src], { text: 'COPY', tiled: false })
    const tiled = await run(pdfWatermark, [src], { text: 'COPY', tiled: true })
    expect(await inkInRegion(tiled[0]!.path, 1, HEADER)).toBeGreaterThan(
      await inkInRegion(single[0]!.path, 1, HEADER),
    )
  })

  it('insists on some text', () => {
    expect(pdfWatermark.params.safeParse({ text: '  ' }).success).toBe(false)
  })
})

describe('crop a PDF', () => {
  it('trims the page to the fraction requested', async () => {
    const src = await blankPdf('cr.pdf', 1)
    const [out] = await run(pdfCrop, [src], { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    const size = doc.getPage(0).getSize()
    expect(Math.round(size.width)).toBe(200)
    expect(Math.round(size.height)).toBe(280)
  })

  it('crops every page', async () => {
    const src = await blankPdf('cr-all.pdf', 2)
    const [out] = await run(pdfCrop, [src], { x: 0, y: 0, width: 0.5, height: 1 })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    expect(Math.round(doc.getPage(1).getSize().width)).toBe(200)
  })

  it('refuses a region that runs off the page', () => {
    expect(pdfCrop.params.safeParse({ x: 0.8, y: 0, width: 0.5, height: 1 }).success).toBe(false)
    expect(pdfCrop.params.safeParse({ x: 0, y: 0, width: 0, height: 1 }).success).toBe(false)
  })
})

describe('images to PDF', () => {
  it('makes one page per image', async () => {
    const a = await fx.writeJpeg(dir, 'i1.jpg', 300, 200)
    const b = await fx.writePng(dir, 'i2.png', 200, 300)
    const [out] = await run(imagesToPdf, [a, b])
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    expect(doc.getPageCount()).toBe(2)
  })

  it('fits the page to the image by default, keeping its proportions', async () => {
    const wide = await fx.writeJpeg(dir, 'wide.jpg', 400, 200)
    const [out] = await run(imagesToPdf, [wide])
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    const { width, height } = doc.getPage(0).getSize()
    expect(width / height).toBeCloseTo(2, 1)
  })

  it('puts the picture on the page, not a blank sheet', async () => {
    const dark = join(dir, 'dark.png')
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#111111' } }).png().toFile(dark)
    const [out] = await run(imagesToPdf, [dark])
    // A dark image makes a dark page.
    const { pageLuminance } = await import('./helpers/pdfink.js')
    expect(await pageLuminance(out!.path, 1)).toBeLessThan(80)
  })

  it('uses a fixed paper size when asked', async () => {
    const img = await fx.writeJpeg(dir, 'a4.jpg', 300, 300)
    const [out] = await run(imagesToPdf, [img], { pageSize: 'a4' })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    const { width, height } = doc.getPage(0).getSize()
    // A4 is 595 x 842 points.
    expect(Math.round(width)).toBe(595)
    expect(Math.round(height)).toBe(842)
  })

  it('accepts images, not PDFs, even though it lives in the PDF menu', () => {
    expect(imagesToPdf.family).toBe('pdf')
    expect(imagesToPdf.accepts).toContain('image/jpeg')
    expect(imagesToPdf.accepts).not.toContain('application/pdf')
  })
})
