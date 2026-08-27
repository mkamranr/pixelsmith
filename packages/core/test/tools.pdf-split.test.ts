import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitPdf } from '../src/tools/pdf-split.js'
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

/** A document whose pages are labelled, so a range can be checked by content. */
async function makePdf(name: string, pages: number): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    doc.addPage([400, 300]).drawText(`P${i + 1}`, { x: 30, y: 140, size: 40, font })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

/**
 * A document with a weighty page each, for splitting by size. Noise does not
 * compress, so each page really is about as large as it looks.
 */
async function makeHeavyPdf(name: string, pages: number, pixels = 250): Promise<string> {
  const doc = await PDFDocument.create()

  for (let i = 0; i < pages; i++) {
    /**
     * A different image per page, so the weight really is per page — one shared
     * image would make every page look heavy while the document stayed small.
     *
     * The bytes come from an xorshift rather than a counter: a linear sequence
     * looks like noise but deflates to almost nothing, which made these pages
     * far too light to split by size.
     */
    const noise = Buffer.alloc(pixels * pixels * 3)
    let x = 123456789 + i * 2654435761
    for (let n = 0; n < noise.length; n++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      noise[n] = x & 255
    }
    const png = await sharp(noise, { raw: { width: pixels, height: pixels, channels: 3 } }).png().toBuffer()
    const image = await doc.embedPng(png)
    const page = doc.addPage([400, 400])
    page.drawImage(image, { x: 0, y: 0, width: 400, height: 400 })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], params: unknown = {}) =>
  runTool(splitPdf, { inputs, outDir: join(outDir, `s${seq++}`), params })

const pagesIn = async (path: string) =>
  (await PDFDocument.load(await readFile(path))).getPageCount()

/** The page labels a part actually holds, read back out of the document. */
async function labelsIn(path: string): Promise<string[]> {
  const { extractPdfText } = await import('../src/pdf-text.js')
  return (await extractPdfText(path)).map((text) => text.trim())
}

describe('splitting by custom ranges', () => {
  it('writes one document per range', async () => {
    const src = await makePdf('r-two.pdf', 6)
    const outs = await run([src], { mode: 'ranges', ranges: '1-2,4-5' })

    expect(outs).toHaveLength(2)
    expect(await pagesIn(outs[0]!.path)).toBe(2)
    expect(await pagesIn(outs[1]!.path)).toBe(2)
  })

  it('puts the right pages in each range, not merely the right number', async () => {
    const src = await makePdf('r-content.pdf', 6)
    const outs = await run([src], { mode: 'ranges', ranges: '1-2,4-5' })

    expect(await labelsIn(outs[0]!.path)).toEqual(['P1', 'P2'])
    expect(await labelsIn(outs[1]!.path)).toEqual(['P4', 'P5'])
  })

  it('names each part after the range it holds', async () => {
    const src = await makePdf('r-name.pdf', 6)
    const outs = await run([src], { mode: 'ranges', ranges: '1-2,4-5' })
    expect(outs.map((o) => o.name)).toEqual(['r-name-1-2.pdf', 'r-name-4-5.pdf'])
  })

  it('accepts a single page as a range', async () => {
    const src = await makePdf('r-single.pdf', 4)
    const outs = await run([src], { mode: 'ranges', ranges: '3' })

    expect(outs).toHaveLength(1)
    expect(await labelsIn(outs[0]!.path)).toEqual(['P3'])
  })

  it('can put every range in one document instead', async () => {
    const src = await makePdf('r-merge.pdf', 6)
    const outs = await run([src], { mode: 'ranges', ranges: '1-2,4-5', mergeAll: true })

    expect(outs).toHaveLength(1)
    expect(await labelsIn(outs[0]!.path)).toEqual(['P1', 'P2', 'P4', 'P5'])
  })

  it('refuses a range that runs past the end', async () => {
    const src = await makePdf('r-oob.pdf', 3)
    await expect(run([src], { mode: 'ranges', ranges: '2-9' })).rejects.toThrow(/9|past the end/i)
  })

  it('refuses a range that ends before it starts', async () => {
    const src = await makePdf('r-back.pdf', 6)
    await expect(run([src], { mode: 'ranges', ranges: '5-2' })).rejects.toThrow(/before/i)
  })

  it('asks for a range rather than quietly copying the document', async () => {
    const src = await makePdf('r-blank.pdf', 3)
    await expect(run([src], { mode: 'ranges', ranges: '' })).rejects.toThrow(/range/i)
  })
})

describe('splitting every so many pages', () => {
  it('makes parts of the size asked for, with a shorter last part', async () => {
    const src = await makePdf('f-two.pdf', 5)
    const outs = await run([src], { mode: 'fixed', every: 2 })

    expect(outs.map((o) => o.name)).toEqual(['f-two-part-1.pdf', 'f-two-part-2.pdf', 'f-two-part-3.pdf'])
    expect(await Promise.all(outs.map((o) => pagesIn(o.path)))).toEqual([2, 2, 1])
  })

  it('keeps the pages in order across the parts', async () => {
    const src = await makePdf('f-order.pdf', 5)
    const outs = await run([src], { mode: 'fixed', every: 2 })

    expect(await labelsIn(outs[0]!.path)).toEqual(['P1', 'P2'])
    expect(await labelsIn(outs[2]!.path)).toEqual(['P5'])
  })
})

describe('splitting into pages', () => {
  it('writes one document per page when no selection is given', async () => {
    const src = await makePdf('p-each.pdf', 4)
    const outs = await run([src], { mode: 'pages' })

    expect(outs).toHaveLength(4)
    expect(outs.map((o) => o.name)).toEqual([
      'p-each-page-1.pdf',
      'p-each-page-2.pdf',
      'p-each-page-3.pdf',
      'p-each-page-4.pdf',
    ])
  })

  it('is what a bare job does, so one click still splits a document', async () => {
    const src = await makePdf('p-default.pdf', 3)
    const outs = await run([src])
    expect(outs).toHaveLength(3)
  })

  it('pulls out a selection as one document', async () => {
    const src = await makePdf('p-sel.pdf', 6)
    const outs = await run([src], { mode: 'pages', pages: '2-3,5' })

    expect(outs).toHaveLength(1)
    expect(await labelsIn(outs[0]!.path)).toEqual(['P2', 'P3', 'P5'])
  })

  it('refuses a selection past the end of the document', async () => {
    const src = await makePdf('p-oob.pdf', 2)
    await expect(run([src], { mode: 'pages', pages: '5' })).rejects.toThrow(/past the end/)
  })
})

describe('splitting by file size', () => {
  it('keeps each part under the size asked for', async () => {
    const src = await makeHeavyPdf('z-heavy.pdf', 4)
    const outs = await run([src], { mode: 'size', maxMb: 0.4 })

    expect(outs.length).toBeGreaterThan(1)
    for (const out of outs) expect(out.bytes).toBeLessThanOrEqual(0.4 * 1024 * 1024)
  })

  it('still emits a page that is bigger than the limit on its own', async () => {
    /**
     * A single page cannot be split, so the choice is between one oversized
     * part and losing the page. It goes out oversized, alone.
     */
    const src = await makeHeavyPdf('z-huge.pdf', 2, 700)
    const outs = await run([src], { mode: 'size', maxMb: 0.05 })

    expect(outs).toHaveLength(2)
    for (const out of outs) expect(await pagesIn(out.path)).toBe(1)
  })

  it('accounts for every page, losing none to the packing', async () => {
    const src = await makeHeavyPdf('z-count.pdf', 5)
    const outs = await run([src], { mode: 'size', maxMb: 0.4 })

    const total = (await Promise.all(outs.map((o) => pagesIn(o.path)))).reduce((a, b) => a + b, 0)
    expect(total).toBe(5)
  })
})
