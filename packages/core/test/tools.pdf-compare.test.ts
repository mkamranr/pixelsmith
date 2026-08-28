import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('a report in a right-to-left language', () => {
  /**
   * The report has its own line writer, so the alignment fix that went into the
   * shared one did not reach it: an Arabic report came out left-aligned, which
   * reads as though the page were the wrong way round.
   *
   * The title is the line this can be checked on — a fixture cannot carry
   * Arabic body text, because the standard fonts a fixture is built with cannot
   * encode it, which is the whole reason preparePdfText exists.
   */
  const sideOfInk = async (path: string) => {
    const png = await renderPdfPage(path, 1, { scale: 1 })
    const { width = 595, height = 842 } = await sharp(png).metadata()
    const half = Math.floor(width / 2)
    const grey = await sharp(png).greyscale().raw().toBuffer()

    /**
     * The title's own rows, found rather than assumed. The lines under it — the
     * filenames, the counts — are English and stay left-aligned, so a band
     * wide enough to include them measures the wrong thing.
     */
    let from = -1
    let to = -1
    for (let y = 0; y < height; y += 1) {
      let dark = 0
      for (let x = 0; x < width; x += 1) if (grey[y * width + x]! < 200) dark += 1
      if (dark > 0 && from === -1) from = y
      if (dark === 0 && from !== -1) {
        to = y
        break
      }
    }
    expect(from, 'no ink on the page at all').toBeGreaterThan(-1)

    const ink = async (left: number) => {
      const strip = await sharp(png)
        .extract({ left, top: from, width: half, height: Math.max(1, to - from) })
        .greyscale()
        .toBuffer()
      return 255 - (await sharp(strip).stats()).channels[0]!.mean
    }
    return { left: await ink(0), right: await ink(half) }
  }

  it('sets an Arabic title against the right margin', async () => {
    const before = await docOf('rtl-a.pdf', [['Alpha line']])
    const after = await docOf('rtl-b.pdf', [['Beta line']])

    const outs = await run([before, after], { title: 'تقرير المقارنة' })

    const ink = await sideOfInk(outs[0]!.path)
    expect(ink.right).toBeGreaterThan(ink.left)
  })

  it('leaves an English title against the left margin', async () => {
    const before = await docOf('ltr-a.pdf', [['Alpha line']])
    const after = await docOf('ltr-b.pdf', [['Beta line']])

    const outs = await run([before, after], { title: 'Comparison report' })

    const ink = await sideOfInk(outs[0]!.path)
    expect(ink.left).toBeGreaterThan(ink.right)
  })
})

describe('the change list a viewer can draw with', () => {
  /**
   * The report says what changed in words. Showing it means knowing WHERE each
   * change is on the page, which the report does not carry — so the comparison
   * also writes the changes out with the box each one occupies, and which of
   * the two documents it belongs to.
   */
  const changesOf = async (outs: Awaited<ReturnType<typeof run>>) => {
    const file = outs.find((o) => o.mime === 'application/json')
    expect(file, 'no change list was written').toBeDefined()
    return JSON.parse(await readFile(file!.path, 'utf8'))
  }

  it('writes the changes out beside the report', async () => {
    const before = await docOf('cl-a.pdf', [['Alpha line', 'Beta line']])
    const after = await docOf('cl-b.pdf', [['Alpha line', 'Gamma line']])

    const list = await changesOf(await run([before, after]))

    expect(list.changes.length).toBeGreaterThan(0)
    expect(list.before.name).toBe('cl-a.pdf')
    expect(list.after.name).toBe('cl-b.pdf')
  })

  it('says which document each change belongs to', async () => {
    const before = await docOf('cl-c.pdf', [['Kept', 'Departed']])
    const after = await docOf('cl-d.pdf', [['Kept', 'Arrived']])

    const list = await changesOf(await run([before, after]))
    const gone = list.changes.find((c: { text: string }) => c.text.includes('Departed'))
    const came = list.changes.find((c: { text: string }) => c.text.includes('Arrived'))

    expect(gone).toMatchObject({ side: 'before', kind: 'removed', page: 1 })
    expect(came).toMatchObject({ side: 'after', kind: 'added', page: 1 })
  })

  it('puts a box around the line that changed, not the whole page', async () => {
    // The fixture writes lines 20 points apart from y=440 down, so a box that
    // covers the page — or the wrong line — is caught here rather than by eye.
    const before = await docOf('cl-e.pdf', [['First', 'Second', 'Third']])
    const after = await docOf('cl-f.pdf', [['First', 'CHANGED', 'Third']])

    const list = await changesOf(await run([before, after]))
    const change = list.changes.find((c: { text: string }) => c.text.includes('CHANGED'))

    expect(change.pageSize).toMatchObject({ width: 400, height: 500 })
    expect(change.box.height).toBeLessThan(40)
    expect(change.box.width).toBeLessThan(200)
    // Second line of three, so roughly a fifth of the way down a 500pt page.
    expect(change.box.y).toBeGreaterThan(30)
    expect(change.box.y).toBeLessThan(120)
  })

  it('finds a change on the page it is actually on', async () => {
    const before = await docOf('cl-g.pdf', [['Page one'], ['Page two same'], ['Page three old']])
    const after = await docOf('cl-h.pdf', [['Page one'], ['Page two same'], ['Page three new']])

    const list = await changesOf(await run([before, after]))

    expect(list.changes.every((c: { page: number }) => c.page === 3)).toBe(true)
  })

  it('writes an empty list rather than no list when nothing differs', async () => {
    // A viewer that has to cope with a missing file is a viewer with two paths
    // through it, one of which is rarely exercised.
    const same = await docOf('cl-i.pdf', [['Identical']])
    const copy = await docOf('cl-j.pdf', [['Identical']])

    const list = await changesOf(await run([same, copy]))

    expect(list.changes).toEqual([])
  })
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
