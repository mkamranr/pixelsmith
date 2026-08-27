import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { redactPdf } from '../src/tools/pdf-redact.js'
import { extractPdfText } from '../src/pdf-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let doc: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const first = pdf.addPage([300, 400])
  first.drawText('SECRET', { x: 40, y: 200, size: 24, font })
  first.drawText('public heading', { x: 40, y: 340, size: 12, font })
  pdf.addPage([300, 400]).drawText('second page', { x: 40, y: 200, size: 12, font })
  doc = join(dir, 'sensitive.pdf')
  await writeFile(doc, await pdf.save())
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (params: unknown, inputs = [doc]) =>
  runTool(redactPdf, {
    inputs,
    outDir: join(outDir, `r${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })

/** A box over the word SECRET, in fractions of the page from the top left. */
const OVER_SECRET = JSON.stringify([{ page: 1, x: 0.05, y: 0.4, width: 0.7, height: 0.16 }])

describe('redact a PDF', () => {
  it('insists on at least one marked area', () => {
    expect(redactPdf.params.safeParse({}).success).toBe(false)
    expect(redactPdf.params.safeParse({ regions: '[]' }).success).toBe(false)
    expect(redactPdf.params.safeParse({ regions: OVER_SECRET }).success).toBe(true)
  })

  it('removes the text rather than covering it up', async () => {
    // The whole point. A black rectangle drawn over live text is not
    // redaction: the words are still in the file for anyone who selects them.
    const outs = await run({ regions: OVER_SECRET })
    const pages = await extractPdfText(outs[0]!.path)

    expect(pages.join(' ')).not.toContain('SECRET')
    // Nothing else survives as text either, which is the honest consequence of
    // rasterising, and is what the tool tells the user it will do.
    expect(pages.join('').trim()).toBe('')
  })

  it('actually blacks out the marked area', async () => {
    const outs = await run({ regions: OVER_SECRET })
    const png = await renderPdfPage(outs[0]!.path, 1, { scale: 1 })
    const image = sharp(png)
    const { width, height } = await image.metadata()

    /**
     * The extract has to be materialised before measuring: sharp's `stats()`
     * reads the input image and ignores pipeline operations, so chaining
     * `.extract().stats()` silently reports the whole page instead of the box.
     */
    const region = await image
      .clone()
      .extract({
        left: Math.round(0.1 * width!),
        top: Math.round(0.44 * height!),
        width: Math.round(0.5 * width!),
        height: Math.round(0.08 * height!),
      })
      .toBuffer()
    const marked = await sharp(region).stats()
    // Black ink, not a light grey approximation of it.
    expect(marked.channels[0]!.mean).toBeLessThan(12)
  })

  it('leaves unmarked pages looking as they did', async () => {
    const outs = await run({ regions: OVER_SECRET })
    const png = await renderPdfPage(outs[0]!.path, 2, { scale: 1 })
    const stats = await sharp(png).stats()
    // Mostly paper, so the page was not blacked out wholesale.
    expect(stats.channels[0]!.mean).toBeGreaterThan(200)
  })

  it('keeps the page count and the page size', async () => {
    const outs = await run({ regions: OVER_SECRET })
    const result = await PDFDocument.load(await readFile(outs[0]!.path))

    expect(result.getPageCount()).toBe(2)
    const { width, height } = result.getPage(0).getSize()
    expect(Math.round(width)).toBe(300)
    expect(Math.round(height)).toBe(400)
  })

  it('refuses a box outside the document', async () => {
    const beyond = JSON.stringify([{ page: 9, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }])
    await expect(run({ regions: beyond })).rejects.toThrow(/page 9/i)
  })
})

/** Mean brightness of a region of a rendered page; 0 is solid black. */
async function brightnessAt(
  path: string,
  page: number,
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const png = await renderPdfPage(path, page, { scale: 1 })
  const image = sharp(png)
  const { width, height } = await image.metadata()
  const region = await image
    .clone()
    .extract({
      left: Math.round(box.x * width!),
      top: Math.round(box.y * height!),
      width: Math.max(1, Math.round(box.width * width!)),
      height: Math.max(1, Math.round(box.height * height!)),
    })
    .toBuffer()
  return (await sharp(region).stats()).channels[0]!.mean
}

/**
 * Marking by hand is fine for one box on one page. Finding every occurrence of a
 * name across forty pages is not, which is why the words themselves can be the
 * instruction.
 */
describe('redacting by what the words say', () => {
  let byWords: string

  beforeAll(async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    page.drawText('SECRET', { x: 40, y: 400, size: 24, font })
    page.drawText('keep me', { x: 40, y: 200, size: 24, font })
    page.drawText('reach a.nadir@example.test', { x: 40, y: 100, size: 14, font })
    byWords = join(dir, 'by-words.pdf')
    await writeFile(byWords, await pdf.save())
  })

  it('takes a phrase instead of coordinates', () => {
    expect(redactPdf.params.safeParse({ findText: 'SECRET' }).success).toBe(true)
    expect(redactPdf.params.safeParse({ redactEmails: true }).success).toBe(true)
    // Still refuses a job that would do nothing at all.
    expect(redactPdf.params.safeParse({}).success).toBe(false)
  })

  it('blacks out the phrase and leaves the rest of the page alone', async () => {
    const outs = await run({ findText: 'SECRET' }, [byWords])

    // Where SECRET was: covered.
    expect(await brightnessAt(outs[0]!.path, 1, { x: 0.1, y: 0.17, width: 0.2, height: 0.04 }))
      .toBeLessThan(60)
    // Where the words to keep are: still paper and ink, not a black bar.
    expect(await brightnessAt(outs[0]!.path, 1, { x: 0.05, y: 0.56, width: 0.4, height: 0.1 }))
      .toBeGreaterThan(150)
  })

  it('removes the phrase from the file, not just from view', async () => {
    const outs = await run({ findText: 'SECRET' }, [byWords])
    expect((await extractPdfText(outs[0]!.path)).join(' ')).not.toContain('SECRET')
  })

  it('finds an email address without being told the address', async () => {
    const outs = await run({ redactEmails: true }, [byWords])
    expect(await brightnessAt(outs[0]!.path, 1, { x: 0.25, y: 0.78, width: 0.3, height: 0.04 }))
      .toBeLessThan(90)
  })

  it('does nothing to a document that does not contain the phrase', async () => {
    const outs = await run({ findText: 'nowhere-in-here' }, [byWords])
    // Rasterised, so the text is gone either way — but nothing is blacked out.
    expect(await brightnessAt(outs[0]!.path, 1, { x: 0.1, y: 0.17, width: 0.2, height: 0.04 }))
      .toBeGreaterThan(150)
  })
})
