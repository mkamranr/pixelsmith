import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PDF_LIMITS, probePdf } from '../src/pdf.js'
import { EncryptedPdfError, LimitExceededError, MalformedPdfError, UnsupportedInputError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string

beforeAll(async () => {
  dir = await fx.scratchDir()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A real PDF with the requested number of pages, each labelled. */
export async function writePdf(dir: string, name: string, pages = 1) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([420, 300])
    page.drawText(`Page ${i + 1}`, { x: 40, y: 150, size: 28, font, color: rgb(0.1, 0.1, 0.1) })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

describe('probePdf', () => {
  it('identifies a PDF and counts its pages', async () => {
    const path = await writePdf(dir, 'three.pdf', 3)
    expect(await probePdf(path, DEFAULT_PDF_LIMITS)).toMatchObject({
      mime: 'application/pdf',
      pages: 3,
      encrypted: false,
    })
  })

  it('reports the real byte size', async () => {
    const path = await writePdf(dir, 'size.pdf', 1)
    const probe = await probePdf(path, DEFAULT_PDF_LIMITS)
    expect(probe.bytes).toBeGreaterThan(100)
  })

  it('rejects a file that is not a PDF at all', async () => {
    const path = join(dir, 'notpdf.pdf')
    await writeFile(path, 'just some text pretending to be a document')
    await expect(probePdf(path, DEFAULT_PDF_LIMITS)).rejects.toThrow(UnsupportedInputError)
  })

  it('rejects an image renamed to .pdf, since the bytes are what count', async () => {
    const png = await fx.writePng(dir, 'liar.pdf', 40, 40)
    await expect(probePdf(png, DEFAULT_PDF_LIMITS)).rejects.toThrow(UnsupportedInputError)
  })

  it('rejects an empty file', async () => {
    const path = join(dir, 'empty.pdf')
    await writeFile(path, Buffer.alloc(0))
    await expect(probePdf(path, DEFAULT_PDF_LIMITS)).rejects.toThrow(MalformedPdfError)
  })

  it('rejects a truncated PDF rather than passing half a document downstream', async () => {
    const full = await writePdf(dir, 'whole.pdf', 2)
    const bytes = await (await import('node:fs/promises')).readFile(full)
    const cut = join(dir, 'cut.pdf')
    await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 3)))
    await expect(probePdf(cut, DEFAULT_PDF_LIMITS)).rejects.toThrow(MalformedPdfError)
  })

  it('refuses a document with more pages than the limit', async () => {
    const path = await writePdf(dir, 'many.pdf', 12)
    await expect(probePdf(path, { ...DEFAULT_PDF_LIMITS, maxPages: 5 })).rejects.toThrow(LimitExceededError)
  })

  it('refuses a document larger than the byte limit before parsing it', async () => {
    const path = await writePdf(dir, 'heavy.pdf', 2)
    await expect(probePdf(path, { ...DEFAULT_PDF_LIMITS, maxBytes: 64 })).rejects.toThrow(LimitExceededError)
  })

  it('reports an encrypted document as such, rather than failing obscurely', async () => {
    // A password-protected PDF cannot be edited without the password, so the
    // user needs to be told that plainly.
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    const bytes = await doc.save()
    // pdf-lib cannot write encryption, so simulate the marker qpdf-produced
    // files carry: an /Encrypt entry in the trailer.
    const path = join(dir, 'locked.pdf')
    const withEncrypt = Buffer.from(
      Buffer.from(bytes).toString('latin1').replace('/Root', '/Encrypt 9 0 R /Root'),
      'latin1',
    )
    await writeFile(path, withEncrypt)
    await expect(probePdf(path, DEFAULT_PDF_LIMITS)).rejects.toThrow(EncryptedPdfError)
  })

  it('accepts a single-page document at the page limit boundary', async () => {
    const path = await writePdf(dir, 'edge.pdf', 5)
    await expect(probePdf(path, { ...DEFAULT_PDF_LIMITS, maxPages: 5 })).resolves.toMatchObject({ pages: 5 })
  })
})
