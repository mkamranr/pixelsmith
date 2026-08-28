import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { extractPdfText } from '../src/pdf-text.js'
import { loadPdf } from '../src/pdf.js'
import { removePages } from '../src/tools/pdf-remove-pages.js'
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

/** A document whose pages say which page they are, so order is checkable. */
async function labelled(name: string, count: number): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= count; page += 1) {
    doc.addPage([300, 400]).drawText(`PAGE ${page}`, { x: 40, y: 200, size: 20, font })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], params: unknown) =>
  runTool(removePages, {
    inputs,
    outDir: join(outDir, `r${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })

const labelsOf = async (path: string) =>
  (await extractPdfText(path)).map((page) => page.replace(/\s+/g, ' ').trim())

describe('removing pages from a PDF', () => {
  it('drops the page it was told to and keeps the rest in order', async () => {
    const src = await labelled('drop-one.pdf', 4)

    const [out] = await run([src], { pages: '2' })

    expect(await labelsOf(out!.path)).toEqual(['PAGE 1', 'PAGE 3', 'PAGE 4'])
  })

  it('takes a range, and a list, and both together', async () => {
    const src = await labelled('drop-many.pdf', 8)

    const [out] = await run([src], { pages: '2-3,6,8' })

    expect(await labelsOf(out!.path)).toEqual(['PAGE 1', 'PAGE 4', 'PAGE 5', 'PAGE 7'])
  })

  it('says how many it removed, for a page that wants to report it', async () => {
    const src = await labelled('counted.pdf', 5)

    const [out] = await run([src], { pages: '1,5' })

    expect(out!.meta).toMatchObject({ removed: 2, kept: 3 })
  })

  it('refuses to remove every page, which would leave nothing', async () => {
    // A PDF with no pages is not a document, and handing one back as a result
    // is worse than saying no.
    const src = await labelled('all-of-them.pdf', 3)

    await expect(run([src], { pages: '1-3' })).rejects.toThrow(/every page|nothing/i)
  })

  it('insists on being told which pages, rather than guessing', async () => {
    // Blank means "all" on the tools that turn or crop pages, where it is
    // harmless. Here it would mean deleting the document.
    expect(removePages.params.safeParse({}).success).toBe(false)
    expect(removePages.params.safeParse({ pages: '   ' }).success).toBe(false)
  })

  it('refuses a page number the document does not have', async () => {
    /**
     * Every other page tool refuses these, and for a destructive operation it
     * is the better answer anyway: someone asking to remove page 9 of a
     * three-page document may well have the wrong document open, and quietly
     * removing page 2 alone would hide that.
     */
    const src = await labelled('beyond.pdf', 3)

    await expect(run([src], { pages: '2,9' })).rejects.toThrow(/past the end/i)
  })

  it('works through a batch, each document keeping its own name', async () => {
    const one = await labelled('batch-one.pdf', 3)
    const two = await labelled('batch-two.pdf', 3)

    const outs = await run([one, two], { pages: '2' })

    expect(outs.map((o) => o.name)).toEqual(['batch-one.pdf', 'batch-two.pdf'])
    expect((await loadPdf(outs[0]!.path)).getPageCount()).toBe(2)
    expect((await loadPdf(outs[1]!.path)).getPageCount()).toBe(2)
  })

  it('leaves the pages it keeps exactly as they were', async () => {
    // Removing pages is not an excuse to re-encode the ones that stay.
    const src = await labelled('intact.pdf', 3)

    const [out] = await run([src], { pages: '2' })
    const kept = await loadPdf(out!.path)

    expect(kept.getPage(0).getSize()).toMatchObject({ width: 300, height: 400 })
    expect((await labelsOf(out!.path))[0]).toBe('PAGE 1')
  })
})
