import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { diffLines, type DiffChange } from '../diff.js'
import { BadInputError } from '../errors.js'
import { PDF_MIME } from '../pdf.js'
import { preparePdfText } from '../pdf-draw-text.js'
import { pdfPageText, type PageText, type TextPiece } from '../pdf-text.js'
import { stripControlChars, wrapText } from '../text.js'
import type { Tool } from '../registry.js'

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN = 48
const BODY_SIZE = 9
const CHANGE_INDENT = 12

/**
 * A cap on how much of a diff is written out. Two unrelated documents differ on
 * every line, and a report the length of both of them together helps nobody.
 */
const MAX_REPORTED_CHANGES = 400

const REMOVED = { r: 0.7, g: 0.12, b: 0.12 }
const ADDED = { r: 0.09, g: 0.45, b: 0.22 }
const QUIET = { r: 0.35, g: 0.35, b: 0.35 }

export const ComparePdfParams = z.object({
  title: z.string().trim().max(120).default('Comparison'),
})

export type ComparePdfParams = z.infer<typeof ComparePdfParams>

/** A line as the diff sees it, with the space on the page it occupies. */
interface PlacedLine {
  text: string
  box: { x: number; y: number; width: number; height: number }
}

/**
 * The same normalising `linesOf` does, applied to lines that still know where
 * they are. Both the diff and the boxes come from here, so a change can always
 * be pointed at: deriving them separately would let the two disagree about what
 * a line even is.
 *
 * Boxes are given from the top of the page, because that is how a viewer draws.
 */
function placedLines(page: PageText | undefined): PlacedLine[] {
  if (!page) return []
  const out: PlacedLine[] = []

  for (const pieces of page.lines) {
    const text = pieces
      .map((piece) => piece.str)
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (text === '') continue
    out.push({ text, box: boxOf(pieces, page.height) })
  }
  return out
}

function boxOf(pieces: TextPiece[], pageHeight: number) {
  let left = Infinity
  let right = -Infinity
  let baseline = 0
  let size = 0

  for (const piece of pieces) {
    left = Math.min(left, piece.x)
    right = Math.max(right, piece.x + piece.width)
    baseline = Math.max(baseline, piece.y)
    size = Math.max(size, piece.height)
  }

  // A little room above the baseline for ascenders and below for descenders,
  // so the highlight covers the writing rather than clipping it.
  const height = size * 1.35
  return {
    x: Math.round(left * 100) / 100,
    y: Math.round((pageHeight - baseline - size) * 100) / 100,
    width: Math.round((right - left) * 100) / 100,
    height: Math.round(height * 100) / 100,
  }
}

/**
 * Find the line a change refers to. Matched by text rather than by index,
 * because the diff reports what changed and not where it sat.
 *
 * `used` stops two identical lines both claiming the same box. Where a page
 * genuinely repeats a line, the highlight may land on the other copy — the two
 * read identically, so the cost is nil and the alternative is threading indices
 * through a shared alignment routine for no visible gain.
 */
function locate(lines: PlacedLine[], text: string, used: Set<number>) {
  for (let index = 0; index < lines.length; index++) {
    if (used.has(index) || lines[index]!.text !== text) continue
    used.add(index)
    return lines[index]!.box
  }
  return undefined
}

interface Section {
  page: number
  changes: DiffChange[]
}

/** One change, with enough about it to draw a highlight on a rendered page. */
interface LocatedChange {
  page: number
  side: 'before' | 'after'
  kind: DiffChange['kind']
  text: string
  box: { x: number; y: number; width: number; height: number }
  pageSize: { width: number; height: number }
}

export const comparePdf: Tool<ComparePdfParams> = {
  id: 'compare-pdf',
  title: 'Compare PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: ComparePdfParams,
  ui: {
    group: 'pdf-edit',
    icon: 'compare',
    surface: 'canvas',
    result: 'compare',
    preview: 'none',
    blurb:
      'Put two versions of a document side by side and get a report of what changed, page by page. Compares the words, not the layout.',
    fields: [
      { name: 'title', label: 'Report title', kind: 'text', default: 'Comparison' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    if (inputs.length !== 2) {
      throw new BadInputError(
        `choose exactly two documents to compare — this job has ${inputs.length}`,
      )
    }

    const [before, after] = inputs as [(typeof inputs)[0], (typeof inputs)[0]]
    const beforePages = await pdfPageText(before.path)
    const afterPages = await pdfPageText(after.path)
    onProgress?.(0.4)

    const pageCount = Math.max(beforePages.length, afterPages.length)
    const sections: Section[] = []
    let removed = 0
    let added = 0

    const located: LocatedChange[] = []

    for (let index = 0; index < pageCount; index++) {
      const beforeLines = placedLines(beforePages[index])
      const afterLines = placedLines(afterPages[index])
      const changes = diffLines(
        beforeLines.map((line) => line.text),
        afterLines.map((line) => line.text),
      ).filter((change) => change.kind !== 'same')
      if (changes.length === 0) continue

      removed += changes.filter((change) => change.kind === 'removed').length
      added += changes.filter((change) => change.kind === 'added').length
      sections.push({ page: index + 1, changes })

      // The same changes again, carrying where they are, for a viewer to draw.
      const usedBefore = new Set<number>()
      const usedAfter = new Set<number>()
      for (const change of changes) {
        const side = change.kind === 'removed' ? 'before' : 'after'
        const lines = side === 'before' ? beforeLines : afterLines
        const page = side === 'before' ? beforePages[index] : afterPages[index]
        const box = locate(lines, change.text, side === 'before' ? usedBefore : usedAfter)
        if (!box || !page) continue
        located.push({
          page: index + 1,
          side,
          kind: change.kind,
          text: change.text,
          box,
          pageSize: { width: page.width, height: page.height },
        })
      }
    }
    onProgress?.(0.6)

    const report = await PDFDocument.create()
    let page = report.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    let cursor = PAGE_HEIGHT - MARGIN

    /** Write one line, starting a new page when this one runs out. */
    const line = async (
      text: string,
      options: {
        size?: number
        colour?: { r: number; g: number; b: number }
        bold?: boolean
        indent?: number
      } = {},
    ) => {
      const size = options.size ?? BODY_SIZE
      const height = size * 1.4
      if (cursor - height < MARGIN) {
        page = report.addPage([PAGE_WIDTH, PAGE_HEIGHT])
        cursor = PAGE_HEIGHT - MARGIN
      }
      cursor -= height
      if (text === '') return

      const mark = await preparePdfText(report, {
        text,
        size,
        ...(options.colour ? { colour: options.colour } : {}),
        ...(options.bold ? { bold: options.bold } : {}),
      })
      mark.draw(page, { x: MARGIN + (options.indent ?? 0), y: cursor })
    }

    await line(stripControlChars(params.title), { size: 18, bold: true })
    await line('')
    await line(`${before.name} compared with ${after.name}`, { size: 9, colour: QUIET })
    await line('')

    if (sections.length === 0) {
      await line('No differences found in the text of these two documents.', { size: 11 })
    } else {
      await line(
        `${removed} line${removed === 1 ? '' : 's'} removed and ${added} added, across ` +
          `${sections.length} page${sections.length === 1 ? '' : 's'}.`,
        { size: 10 },
      )

      const bodyWidth = PAGE_WIDTH - MARGIN * 2 - CHANGE_INDENT
      let written = 0
      let skipped = 0

      for (const section of sections) {
        await line('')
        await line(`Page ${section.page}`, { size: 11, bold: true })

        for (const change of section.changes) {
          if (written >= MAX_REPORTED_CHANGES) {
            skipped++
            continue
          }
          written++

          const colour = change.kind === 'removed' ? REMOVED : ADDED
          // Plain ASCII markers, so the lines stay real text: a typographic
          // minus sign is outside WinAnsi and would push every removed line
          // onto the rendered-image path for no benefit.
          const marker = change.kind === 'removed' ? '- ' : '+ '
          for (const wrapped of wrapText(marker + change.text, bodyWidth, BODY_SIZE)) {
            await line(wrapped, { colour, indent: CHANGE_INDENT })
          }
        }
      }

      if (skipped > 0) {
        await line('')
        await line(`and ${skipped} further changes, not listed.`, { size: 9, colour: QUIET })
      }
    }

    const name = 'comparison.pdf'
    const dest = join(outDir, name)
    await writeFile(dest, await report.save())
    onProgress?.(1)

    /**
     * The changes again, as data. The report says what changed in words; this
     * says where, which is what a viewer needs to show it on the pages
     * themselves. Written even when nothing changed, so a viewer has one path
     * through it rather than two.
     */
    const listName = name.replace(/\.pdf$/, '') + '-changes.json'
    const listDest = join(outDir, listName)
    await writeFile(
      listDest,
      JSON.stringify(
        {
          before: { name: before.name, pages: beforePages.length },
          after: { name: after.name, pages: afterPages.length },
          removed,
          added,
          pagesCompared: pageCount,
          changes: located,
        },
        null,
        1,
      ),
      'utf8',
    )

    return [
      {
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { removed, added, pagesWithChanges: sections.length, pagesCompared: pageCount },
      },
      {
        path: listDest,
        name: listName,
        mime: 'application/json',
        bytes: (await stat(listDest)).size,
      },
    ]
  },
}
