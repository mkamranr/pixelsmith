import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractPdfRows, extractPdfText } from '../src/pdf-text.js'
import { MalformedPdfError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

async function pdfWith(name: string, draw: (doc: PDFDocument) => void): Promise<string> {
  const doc = await PDFDocument.create()
  draw(doc)
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

describe('reading the text out of a PDF', () => {
  it('returns one entry per page, in page order', async () => {
    const path = await pdfWith('three.pdf', (doc) => {
      for (const word of ['alpha', 'beta', 'gamma']) {
        doc.addPage([300, 400]).drawText(word, { x: 40, y: 300, size: 14 })
      }
    })

    const pages = await extractPdfText(path)
    expect(pages).toHaveLength(3)
    expect(pages[0]).toContain('alpha')
    expect(pages[1]).toContain('beta')
    expect(pages[2]).toContain('gamma')
  })

  it('reads lines top to bottom, not in the order they were written', async () => {
    // A diff is meaningless if the lines come back in content-stream order, so
    // the lower line is drawn first here on purpose.
    const path = await pdfWith('ordered.pdf', (doc) => {
      const page = doc.addPage([300, 400])
      page.drawText('lower line', { x: 40, y: 100, size: 12 })
      page.drawText('upper line', { x: 40, y: 300, size: 12 })
    })

    const [text] = await extractPdfText(path)
    expect(text!.split('\n').map((l) => l.trim())).toEqual(['upper line', 'lower line'])
  })

  it('keeps words on one baseline on one line, with a space between them', async () => {
    const path = await pdfWith('baseline.pdf', (doc) => {
      const page = doc.addPage([300, 400])
      page.drawText('left', { x: 40, y: 200, size: 12 })
      page.drawText('right', { x: 160, y: 200, size: 12 })
    })

    const [text] = await extractPdfText(path)
    expect(text!.trim()).toBe('left right')
  })

  it('gives an empty string for a page with nothing on it', async () => {
    const path = await pdfWith('blank.pdf', (doc) => {
      doc.addPage([300, 400])
    })

    expect(await extractPdfText(path)).toEqual([''])
  })

  it('refuses a file that is not a PDF, through the same error as everything else', async () => {
    const path = join(dir, 'not.pdf')
    await writeFile(path, 'this is not a document')
    await expect(extractPdfText(path)).rejects.toThrow(MalformedPdfError)
  })
})

/**
 * A spreadsheet needs columns, and a PDF has none — only pieces of text at
 * coordinates. Columns in a real table are separated by a gap far wider than
 * the space between words, so that gap is what a cell boundary is inferred
 * from. Prose, having no such gaps, comes back as a single cell per line.
 */
describe('reading a PDF as rows and cells', () => {
  it('splits a line into cells where a table-sized gap appears', async () => {
    const path = await pdfWith('table.pdf', (doc) => {
      const page = doc.addPage([400, 300])
      page.drawText('Region', { x: 40, y: 200, size: 12 })
      page.drawText('Revenue', { x: 200, y: 200, size: 12 })
      page.drawText('Dubai', { x: 40, y: 180, size: 12 })
      page.drawText('412000', { x: 200, y: 180, size: 12 })
    })

    const [page] = await extractPdfRows(path)
    expect(page).toEqual([
      ['Region', 'Revenue'],
      ['Dubai', '412000'],
    ])
  })

  it('keeps ordinary prose as one cell, so a sentence is not chopped up', async () => {
    const path = await pdfWith('prose.pdf', (doc) => {
      const page = doc.addPage([400, 300])
      // Two pieces a word-space apart, as a justified line would be.
      page.drawText('Total for', { x: 40, y: 200, size: 12 })
      page.drawText('the year', { x: 92, y: 200, size: 12 })
    })

    const [page] = await extractPdfRows(path)
    expect(page).toHaveLength(1)
    expect(page![0]).toHaveLength(1)
    expect(page![0]![0]).toContain('Total for')
  })

  it('gives one entry per page and no rows for an empty page', async () => {
    const path = await pdfWith('mixed-rows.pdf', (doc) => {
      doc.addPage([300, 200]).drawText('only page one', { x: 20, y: 100, size: 12 })
      doc.addPage([300, 200])
    })

    const pages = await extractPdfRows(path)
    expect(pages).toHaveLength(2)
    expect(pages[1]).toEqual([])
  })
})
