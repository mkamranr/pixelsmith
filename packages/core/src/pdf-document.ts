import { PDFDocument } from 'pdf-lib'

import { preparePdfText } from './pdf-draw-text.js'
import { stripControlChars, wrapText } from './text.js'

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN = 56
const BODY_SIZE = 11
const TITLE_SIZE = 20
const NOTE_SIZE = 9

export interface TextDocument {
  /** Set large at the top of the first page. */
  title: string
  /** Small grey lines under the title — where it came from, how it was made. */
  notes?: string[]
  /** Paragraphs, separated by blank lines. Wrapped and paginated as needed. */
  body: string
}

/**
 * Lay text out as a document.
 *
 * Through preparePdfText rather than drawText, so a document in Arabic is
 * shaped and ordered properly instead of throwing on the first character —
 * which is the whole reason the tools that produce prose share this.
 */
export async function writeTextDocument(spec: TextDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursor = PAGE_HEIGHT - MARGIN

  const line = async (text: string, size = BODY_SIZE, bold = false, grey = false) => {
    const height = size * 1.45
    if (cursor - height < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      cursor = PAGE_HEIGHT - MARGIN
    }
    cursor -= height
    if (text === '') return

    const mark = await preparePdfText(doc, {
      text,
      size,
      bold,
      ...(grey ? { colour: { r: 0.35, g: 0.35, b: 0.35 } } : {}),
    })
    mark.draw(page, { x: MARGIN, y: cursor })
  }

  await line(spec.title, TITLE_SIZE, true)
  await line('')
  for (const note of spec.notes ?? []) await line(note, NOTE_SIZE, false, true)
  if (spec.notes?.length) await line('')

  const width = PAGE_WIDTH - MARGIN * 2
  for (const paragraph of stripControlChars(spec.body).split(/\n+/)) {
    if (paragraph.trim() === '') {
      await line('')
      continue
    }
    for (const wrapped of wrapText(paragraph.trim(), width, BODY_SIZE)) {
      await line(wrapped, BODY_SIZE)
    }
    await line('')
  }

  return doc.save()
}
