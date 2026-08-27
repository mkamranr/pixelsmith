import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderPdfPage, renderPdfPages } from '../src/pdf-render.js'
import { pdfToImage } from '../src/tools/pdf-to-image.js'
import { runTool } from '../src/run.js'
import { BadInputError } from '../src/errors.js'
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

/**
 * A document whose pages are unambiguous to measure: page 1 is half black,
 * page 2 is entirely black, page 3 is blank white.
 */
async function measurablePdf(name: string) {
  const doc = await PDFDocument.create()
  const one = doc.addPage([200, 200])
  one.drawRectangle({ x: 0, y: 0, width: 200, height: 100, color: rgb(0, 0, 0) })
  const two = doc.addPage([200, 200])
  two.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0, 0, 0) })
  doc.addPage([200, 200])
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const meanOf = async (png: Buffer) => (await sharp(png).stats()).channels[0]!.mean

describe('renderPdfPage', () => {
  it('renders a page to a measurable raster', async () => {
    const path = await measurablePdf('m1.pdf')
    const png = await renderPdfPage(path, 1, { scale: 1.5 })
    expect(Math.round(await meanOf(png))).toBe(128)
  })

  it('renders the page asked for, not always the first', async () => {
    const path = await measurablePdf('m2.pdf')
    expect(Math.round(await meanOf(await renderPdfPage(path, 2)))).toBe(0)
    expect(Math.round(await meanOf(await renderPdfPage(path, 3)))).toBe(255)
  })

  it('scales the output', async () => {
    const path = await measurablePdf('m3.pdf')
    const small = await sharp(await renderPdfPage(path, 1, { scale: 1 })).metadata()
    const large = await sharp(await renderPdfPage(path, 1, { scale: 3 })).metadata()
    expect(large.width!).toBeGreaterThan(small.width! * 2.5)
  })

  it('paints a white ground, so a transparent page is not black', async () => {
    const path = await measurablePdf('m4.pdf')
    expect(Math.round(await meanOf(await renderPdfPage(path, 3)))).toBe(255)
  })

  it('refuses a page that does not exist', async () => {
    const path = await measurablePdf('m5.pdf')
    await expect(renderPdfPage(path, 9)).rejects.toThrow(BadInputError)
    await expect(renderPdfPage(path, 0)).rejects.toThrow(BadInputError)
  })

  it('renders several pages in one pass', async () => {
    const path = await measurablePdf('m6.pdf')
    const pages = await renderPdfPages(path, [2, 3])
    expect(pages).toHaveLength(2)
    expect(Math.round(await meanOf(pages[0]!))).toBe(0)
    expect(Math.round(await meanOf(pages[1]!))).toBe(255)
  })
})

describe('pdf to image', () => {
  const run = (inputs: string[], params: unknown = {}) =>
    runTool(pdfToImage, { inputs, outDir: join(outDir, `p${seq++}`), params })

  it('writes one image per page', async () => {
    const path = await measurablePdf('t1.pdf')
    const outs = await run([path])
    expect(outs).toHaveLength(3)
    expect(outs[0]!.mime).toBe('image/jpeg')
  })

  it('names each image after its page', async () => {
    const path = await measurablePdf('t2.pdf')
    const outs = await run([path])
    expect(outs.map((o) => o.name)).toEqual(['t2-page-1.jpg', 't2-page-2.jpg', 't2-page-3.jpg'])
  })

  it('converts only the pages named', async () => {
    const path = await measurablePdf('t3.pdf')
    const outs = await run([path], { pages: '2' })
    expect(outs).toHaveLength(1)
    expect(Math.round(await meanOf(await sharp(outs[0]!.path).toBuffer()))).toBe(0)
  })

  it('writes PNG when asked', async () => {
    const path = await measurablePdf('t4.pdf')
    const outs = await run([path], { format: 'png', pages: '1' })
    expect(outs[0]!.mime).toBe('image/png')
    expect((await sharp(outs[0]!.path).metadata()).format).toBe('png')
  })

  it('renders at a higher resolution for a larger dpi', async () => {
    const path = await measurablePdf('t5.pdf')
    const low = await run([path], { pages: '1', dpi: 72 })
    const high = await run([path], { pages: '1', dpi: 300 })
    const w = async (p: string) => (await sharp(p).metadata()).width!
    expect(await w(high[0]!.path)).toBeGreaterThan((await w(low[0]!.path)) * 3)
  })

  it('refuses a dpi that would produce an unusable file', () => {
    expect(pdfToImage.params.safeParse({ dpi: 5 }).success).toBe(false)
    expect(pdfToImage.params.safeParse({ dpi: 2000 }).success).toBe(false)
  })

  it('belongs to the PDF family but produces images', () => {
    expect(pdfToImage.family).toBe('pdf')
    expect(pdfToImage.accepts).toContain('application/pdf')
  })
})
