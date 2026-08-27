import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mergePdf } from '../src/tools/pdf-merge.js'
import { splitPdf } from '../src/tools/pdf-split.js'
import { rotatePdf } from '../src/tools/pdf-rotate.js'
import { organizePdf } from '../src/tools/pdf-organize.js'
import { runTool } from '../src/run.js'
import { ALL_TOOLS } from '../src/tools/index.js'
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

/** A PDF whose pages are labelled, so reordering can be verified. */
async function makePdf(name: string, pages = 3, size: [number, number] = [400, 300]) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(size)
    page.drawText(`P${i + 1}`, { x: 30, y: 140, size: 40, font, color: rgb(0, 0, 0) })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (tool: Parameters<typeof runTool>[0], inputs: string[], params: unknown = {}) =>
  runTool(tool, { inputs, outDir: join(outDir, `r${seq++}`), params })

const pagesIn = async (path: string) => (await PDFDocument.load(await (await import('node:fs/promises')).readFile(path))).getPageCount()

describe('the two tool families', () => {
  it('marks every tool as belonging to images or PDFs', () => {
    for (const tool of ALL_TOOLS) {
      expect(['image', 'pdf']).toContain(tool.family)
    }
  })

  it('has tools in both families', () => {
    expect(ALL_TOOLS.filter((t) => t.family === 'image').length).toBeGreaterThan(5)
    expect(ALL_TOOLS.filter((t) => t.family === 'pdf').length).toBeGreaterThan(3)
  })

  it('gives every PDF tool a coherent input type', () => {
    /**
     * A PDF tool does one of three things: works on documents, converts
     * something else into one, or generates one from its parameters alone.
     * Stated as a rule rather than a list of exempt names, so it keeps holding
     * as tools are added — and a tool that accepts nothing while claiming to
     * need uploads is caught.
     */
    for (const tool of ALL_TOOLS.filter((t) => t.family === 'pdf')) {
      const generates = tool.inputMode === 'none'
      const takesPdf = tool.accepts.includes('application/pdf')
      const takesImages = tool.accepts.some((mime) => mime.startsWith('image/'))
      expect(generates || takesPdf || takesImages).toBe(true)
      // A generator must not also claim to accept uploads.
      if (generates) expect(tool.accepts).toEqual([])
    }
  })

  it('does not offer PDFs to the image tools', () => {
    for (const tool of ALL_TOOLS.filter((t) => t.family === 'image')) {
      expect(tool.accepts).not.toContain('application/pdf')
    }
  })
})

describe('merge', () => {
  it('joins documents into one, adding up the pages', async () => {
    const a = await makePdf('m-a.pdf', 2)
    const b = await makePdf('m-b.pdf', 3)
    const [out] = await run(mergePdf, [a, b])
    expect(await pagesIn(out!.path)).toBe(5)
    expect(out!.mime).toBe('application/pdf')
  })

  it('keeps the documents in the order they were given', async () => {
    const a = await makePdf('m-first.pdf', 1, [400, 300])
    const b = await makePdf('m-second.pdf', 1, [200, 500])
    const [out] = await run(mergePdf, [a, b])
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    // The first page keeps the first document's shape.
    expect(Math.round(doc.getPage(0).getSize().width)).toBe(400)
    expect(Math.round(doc.getPage(1).getSize().width)).toBe(200)
  })

  it('produces one file even from a single input', async () => {
    const a = await makePdf('m-solo.pdf', 2)
    const outs = await run(mergePdf, [a])
    expect(outs).toHaveLength(1)
    expect(await pagesIn(outs[0]!.path)).toBe(2)
  })
})

describe('split', () => {
  it('writes one document per page by default', async () => {
    const src = await makePdf('s-each.pdf', 4)
    const outs = await run(splitPdf, [src], { mode: 'each' })
    expect(outs).toHaveLength(4)
    for (const out of outs) expect(await pagesIn(out.path)).toBe(1)
  })

  it('names each part after the page it holds', async () => {
    const src = await makePdf('s-name.pdf', 3)
    const outs = await run(splitPdf, [src], { mode: 'each' })
    expect(outs.map((o) => o.name)).toEqual(['s-name-page-1.pdf', 's-name-page-2.pdf', 's-name-page-3.pdf'])
  })

  it('extracts a chosen selection into a single document', async () => {
    const src = await makePdf('s-sel.pdf', 6)
    const outs = await run(splitPdf, [src], { mode: 'select', pages: '2-3,5' })
    expect(outs).toHaveLength(1)
    expect(await pagesIn(outs[0]!.path)).toBe(3)
  })

  it('refuses a selection past the end of the document', async () => {
    const src = await makePdf('s-oob.pdf', 2)
    await expect(run(splitPdf, [src], { mode: 'select', pages: '5' })).rejects.toThrow(/past the end/)
  })
})

describe('rotate', () => {
  it('turns every page by default', async () => {
    const src = await makePdf('r-all.pdf', 2)
    const [out] = await run(rotatePdf, [src], { angle: 90 })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    expect(doc.getPage(1).getRotation().angle).toBe(90)
  })

  it('turns only the pages named', async () => {
    const src = await makePdf('r-some.pdf', 3)
    const [out] = await run(rotatePdf, [src], { angle: 180, pages: '2' })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    expect(doc.getPage(0).getRotation().angle).toBe(0)
    expect(doc.getPage(1).getRotation().angle).toBe(180)
    expect(doc.getPage(2).getRotation().angle).toBe(0)
  })

  it('adds to a rotation that is already there, rather than replacing it', async () => {
    const src = await makePdf('r-twice.pdf', 1)
    const once = await run(rotatePdf, [src], { angle: 90 })
    const twice = await run(rotatePdf, [once[0]!.path], { angle: 90 })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(twice[0]!.path))
    expect(doc.getPage(0).getRotation().angle).toBe(180)
  })

  it('only accepts quarter turns', () => {
    expect(rotatePdf.params.safeParse({ angle: 45 }).success).toBe(false)
    expect(rotatePdf.params.safeParse({ angle: 270 }).success).toBe(true)
  })
})

describe('organize', () => {
  it('reorders pages into the sequence given', async () => {
    const src = await makePdf('o-order.pdf', 3, [400, 300])
    const [out] = await run(organizePdf, [src], { pages: '3,1,2' })
    expect(await pagesIn(out!.path)).toBe(3)
  })

  it('drops pages left out of the selection', async () => {
    const src = await makePdf('o-drop.pdf', 5)
    const [out] = await run(organizePdf, [src], { pages: '1,5' })
    expect(await pagesIn(out!.path)).toBe(2)
  })

  it('duplicates a page named twice', async () => {
    const src = await makePdf('o-dupe.pdf', 2)
    const [out] = await run(organizePdf, [src], { pages: '1,1,2' })
    expect(await pagesIn(out!.path)).toBe(3)
  })

  it('insists on being told which pages to keep', () => {
    // Silently keeping everything would make the tool a no-op with no warning.
    expect(organizePdf.params.safeParse({}).success).toBe(false)
    expect(organizePdf.params.safeParse({ pages: '1' }).success).toBe(true)
  })
})
