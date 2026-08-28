import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { BadInputError } from '../errors.js'
import { deriveName, uniqueName } from '../naming.js'
import { pdfPageText, type PageText, type TextPiece } from '../pdf-text.js'
import { PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'

export const PdfToMarkdownParams = z.object({
  /** A page boundary is not a semantic break, so it is off by default. */
  pageBreaks: z.coerce.boolean().default(false),
})

export type PdfToMarkdownParams = z.infer<typeof PdfToMarkdownParams>

/** How much larger than the body a line must be before it reads as a heading. */
const HEADING_RATIO = 1.15

/** A gap larger than this many multiples of the type size starts a new block. */
const PARAGRAPH_GAP = 1.6

const BULLET = /^[•▪◦·‣∙*•▪-]\s+/
const NUMBERED = /^(\d+)[.)]\s+/

interface Line {
  text: string
  size: number
  /** Distance from the previous line's baseline, in points. */
  gap: number
}

/**
 * Markdown that renders as the words it was given.
 *
 * A line of prose containing an asterisk is prose. Escaping is limited to the
 * characters that would otherwise become formatting, because escaping more than
 * that produces text full of backslashes.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    // Only at the start of a line, where they would become a heading or a rule.
    .replace(/^(\s*)([#>])/, '$1\\$2')
}

function lineOf(pieces: TextPiece[], previous: TextPiece[] | undefined): Line {
  const text = pieces
    .map((piece) => piece.str)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const size = pieces.reduce((largest, piece) => Math.max(largest, piece.height), 0)
  const baseline = pieces.reduce((lowest, piece) => Math.max(lowest, piece.y), 0)
  const previousBaseline = previous
    ? previous.reduce((lowest, piece) => Math.max(lowest, piece.y), 0)
    : baseline
  return { text, size, gap: Math.abs(previousBaseline - baseline) }
}

function linesOf(page: PageText): Line[] {
  const lines: Line[] = []
  page.lines.forEach((pieces, index) => {
    const line = lineOf(pieces, page.lines[index - 1])
    if (line.text !== '') lines.push(line)
  })
  return lines
}

/**
 * The size most of the document is set in.
 *
 * Headings are relative: there is nothing in a PDF that says "this is a
 * heading", only that a run of glyphs is larger than the ones around it. Taking
 * the most common size as the body means a document set entirely in 18pt has no
 * headings, which is the right answer.
 */
function bodySize(lines: Line[]): number {
  const counts = new Map<number, number>()
  for (const line of lines) {
    const rounded = Math.round(line.size * 2) / 2
    counts.set(rounded, (counts.get(rounded) ?? 0) + line.text.length)
  }

  let best = 0
  let most = -1
  for (const [size, weight] of counts) {
    if (weight > most) {
      most = weight
      best = size
    }
  }
  return best || 11
}

/** Heading sizes, largest first, so a rank can become a number of hashes. */
function headingSizes(lines: Line[], body: number): number[] {
  const larger = new Set<number>()
  for (const line of lines) {
    const rounded = Math.round(line.size * 2) / 2
    if (rounded > body * HEADING_RATIO) larger.add(rounded)
  }
  return [...larger].sort((a, b) => b - a).slice(0, 6)
}

export const pdfToMarkdown: Tool<PdfToMarkdownParams> = {
  id: 'pdf-to-markdown',
  title: 'PDF to Markdown',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfToMarkdownParams,
  ui: {
    group: 'pdf-convert',
    icon: 'file-text',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'The words of a document as Markdown, with headings from the type sizes and paragraphs put back together. Layout, images and tables are not carried across — a PDF records where words sit, not what they meant.',
    fields: [
      {
        name: 'pageBreaks',
        label: 'Mark where each page ended',
        kind: 'toggle',
        default: false,
        help: 'Adds a rule between pages. Off by default: a page boundary is not part of the writing.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const pages = await pdfPageText(input.path)
      const all = pages.flatMap(linesOf)

      if (all.length === 0) {
        throw new BadInputError(
          `${input.name} has no text in it — it is images of words, so run OCR over it first`,
        )
      }

      const body = bodySize(all)
      const levels = headingSizes(all, body)
      const blocks: string[] = []

      pages.forEach((page, pageIndex) => {
        if (params.pageBreaks && pageIndex > 0) blocks.push('---')

        let paragraph: string[] = []
        const flush = () => {
          if (paragraph.length) blocks.push(paragraph.join(' '))
          paragraph = []
        }

        for (const line of linesOf(page)) {
          const rounded = Math.round(line.size * 2) / 2
          const level = levels.indexOf(rounded)

          if (level !== -1) {
            flush()
            blocks.push(`${'#'.repeat(Math.min(6, level + 1))} ${escapeMarkdown(line.text)}`)
            continue
          }

          const bullet = BULLET.exec(line.text)
          if (bullet) {
            flush()
            blocks.push(`- ${escapeMarkdown(line.text.slice(bullet[0].length))}`)
            continue
          }

          const numbered = NUMBERED.exec(line.text)
          if (numbered) {
            flush()
            blocks.push(`${numbered[1]}. ${escapeMarkdown(line.text.slice(numbered[0].length))}`)
            continue
          }

          // A gap much larger than the line spacing is where one paragraph
          // ended and the next began; anything less is the same paragraph
          // wrapped by the column it was set in.
          if (paragraph.length && line.gap > line.size * PARAGRAPH_GAP * 1.35) flush()
          paragraph.push(escapeMarkdown(line.text))
        }

        flush()
      })

      const name = uniqueName(taken, deriveName(input.name, { ext: 'md' }))
      const dest = join(outDir, name)
      await writeFile(dest, `${blocks.join('\n\n')}\n`, 'utf8')

      outputs.push({
        path: dest,
        name,
        mime: 'text/markdown',
        bytes: (await stat(dest)).size,
        meta: { blocks: blocks.length, headingLevels: levels.length },
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
