import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comparePdf } from '../src/tools/pdf-compare.js'
import { extractPdfText } from '../src/pdf-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
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

/** A document whose pages are the given lists of lines. */
async function docOf(name: string, pages: string[][]): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const lines of pages) {
    const page = doc.addPage([400, 500])
    lines.forEach((line, index) => {
      page.drawText(line, { x: 40, y: 440 - index * 20, size: 12, font })
    })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], params: unknown = {}) =>
  runTool(comparePdf, {
    inputs,
    outDir: join(outDir, `d${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })

const reportText = async (path: string) => (await extractPdfText(path)).join('\n')

describe('comparing two PDFs', () => {
  it('needs exactly two documents', async () => {
    const one = await docOf('only.pdf', [['a']])
    await expect(run([one])).rejects.toThrow(/two/i)
    await expect(run([one, one, one])).rejects.toThrow(/two/i)
  })

  it('reports what left and what arrived, and on which page', async () => {
    const before = await docOf('before.pdf', [['heading', 'total 100']])
    const after = await docOf('after.pdf', [['heading', 'total 250']])
    const outs = await run([before, after])

    const text = await reportText(outs[0]!.path)
    expect(text).toMatch(/page 1/i)
    expect(text).toContain('total 100')
    expect(text).toContain('total 250')
    // The unchanged line is not worth reporting.
    expect(text).not.toContain('heading')
  })

  it('says so plainly when the two are the same', async () => {
    const same = [['heading', 'total 100']]
    const outs = await run([await docOf('same-a.pdf', same), await docOf('same-b.pdf', same)])

    expect(await reportText(outs[0]!.path)).toMatch(/no differences/i)
  })

  it('notes a page that only one document has', async () => {
    const before = await docOf('short.pdf', [['one']])
    const after = await docOf('long.pdf', [['one'], ['a whole new page']])
    const outs = await run([before, after])

    const text = await reportText(outs[0]!.path)
    expect(text).toMatch(/page 2/i)
    expect(text).toContain('a whole new page')
  })

  it('counts the changes on the report itself', async () => {
    const before = await docOf('c-before.pdf', [['keep', 'drop this']])
    const after = await docOf('c-after.pdf', [['keep', 'and add this']])
    const outs = await run([before, after])

    expect(outs[0]!.name).toBe('comparison.pdf')
    expect(outs[0]!.meta).toMatchObject({ removed: 1, added: 1 })
  })

  it('treats a difference that is only spacing as no difference', async () => {
    /**
     * Not a policy choice so much as an honest one: pdf.js reports a wide gap
     * and a single space identically, so a report claiming a spacing change
     * would be inventing one.
     */
    const before = await docOf('sp-before.pdf', [['total  100']])
    const after = await docOf('sp-after.pdf', [['total 100']])

    expect(await reportText((await run([before, after]))[0]!.path)).toMatch(/no differences/i)
  })

  it('writes a report titled in Arabic without failing', async () => {
    // The standard PDF fonts cannot encode Arabic, so a report that set its
    // headings with them would fail the job outright.
    const before = await docOf('ar-before.pdf', [['total 100']])
    const after = await docOf('ar-after.pdf', [['total 250']])
    const outs = await run([before, after], { title: 'مقارنة المستندات' })

    const png = await renderPdfPage(outs[0]!.path, 1, { scale: 1 })
    const stats = await sharp(png).stats()
    // Blank paper renders as exactly 255 everywhere; anything less is the report.
    expect(Math.min(...stats.channels.map((c) => c.min))).toBeLessThan(250)
  })
})
