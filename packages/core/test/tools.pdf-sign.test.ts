import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signPdf } from '../src/tools/pdf-sign.js'
import { extractPdfText } from '../src/pdf-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let doc: string
let mark: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([300, 400]).drawText('agreement terms', { x: 40, y: 340, size: 12, font })
  pdf.addPage([300, 400]).drawText('signature page', { x: 40, y: 340, size: 12, font })
  doc = join(dir, 'contract.pdf')
  await writeFile(doc, await pdf.save())

  // A solid dark block stands in for a scanned signature: easy to measure.
  mark = join(dir, 'signature.png')
  await writeFile(
    mark,
    await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 10, g: 10, b: 40, alpha: 1 } } })
      .png()
      .toBuffer(),
  )
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (params: unknown, assets: Record<string, string> = {}) =>
  runTool(signPdf, {
    inputs: [doc],
    outDir: join(outDir, `s${seq++}`),
    params,
    assets,
    settings: { allowedRenderHosts: [] } as never,
  })

/** Region means need a materialised extract; stats() ignores the pipeline. */
async function meanOf(png: Buffer, box: { left: number; top: number; width: number; height: number }) {
  const region = await sharp(png).extract(box).toBuffer()
  return (await sharp(region).stats()).channels[0]!.mean
}

describe('sign a PDF', () => {
  it('insists on the words when signing with typed text', () => {
    expect(signPdf.params.safeParse({ kind: 'text' }).success).toBe(false)
    expect(signPdf.params.safeParse({ kind: 'text', text: 'A. Nadir' }).success).toBe(true)
  })

  it('says which file is missing when signing with an image and none was given', async () => {
    await expect(run({ kind: 'image' })).rejects.toThrow(/signature/i)
  })

  it('signs the last page by default, which is where a signature goes', async () => {
    const outs = await run({ kind: 'text', text: 'A. Nadir' })
    const pages = await extractPdfText(outs[0]!.path)

    expect(pages[1]).toContain('A. Nadir')
    expect(pages[0]).not.toContain('A. Nadir')
  })

  it('leaves the document itself intact, unlike redaction', async () => {
    // A signed contract whose text stopped being text would be useless.
    const outs = await run({ kind: 'text', text: 'A. Nadir' })
    const pages = await extractPdfText(outs[0]!.path)

    expect(pages[0]).toContain('agreement terms')
    expect(pages[1]).toContain('signature page')
    const result = await PDFDocument.load(await readFile(outs[0]!.path))
    expect(result.getPageCount()).toBe(2)
  })

  it('puts an image signature where it was placed', async () => {
    const outs = await run(
      { kind: 'image', pages: '1', x: 0.1, y: 0.1, width: 0.5 },
      { signatureFile: mark },
    )
    const png = await renderPdfPage(outs[0]!.path, 1, { scale: 1 })

    // The block is 2:1, so 150pt wide lands 75pt tall from y=40 down.
    expect(await meanOf(png, { left: 45, top: 55, width: 90, height: 40 })).toBeLessThan(80)
    // Away from the mark the page is still paper.
    expect(await meanOf(png, { left: 220, top: 250, width: 60, height: 60 })).toBeGreaterThan(200)
  })

  it('honours an explicit page selection', async () => {
    const outs = await run({ kind: 'text', text: 'A. Nadir', pages: '1' })
    const pages = await extractPdfText(outs[0]!.path)

    expect(pages[0]).toContain('A. Nadir')
    expect(pages[1]).not.toContain('A. Nadir')
  })

  it('signs with an Arabic name, which the standard PDF fonts cannot encode', async () => {
    const outs = await run({ kind: 'text', text: 'أحمد النادي' })
    const png = await renderPdfPage(outs[0]!.path, 2, { scale: 1 })
    const stats = await sharp(png).stats()
    // Blank paper renders as exactly 255; anything less is the signature.
    expect(Math.min(...stats.channels.map((c) => c.min))).toBeLessThan(250)
  })

  it('can add a caption under the signature, for a name or a date', async () => {
    const outs = await run({ kind: 'text', text: 'A. Nadir', caption: 'Signed 27 August 2026' })
    expect((await extractPdfText(outs[0]!.path))[1]).toContain('Signed 27 August 2026')
  })
})
