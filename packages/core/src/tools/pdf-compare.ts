import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { diffLines, type DiffChange } from '../diff.js'
import { BadInputError } from '../errors.js'
import { PDF_MIME } from '../pdf.js'
import { preparePdfText } from '../pdf-draw-text.js'
import { extractPdfText } from '../pdf-text.js'
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

/**
 * Runs of whitespace collapse to one space and the ends are trimmed, because
 * pdf.js reports a wide gap and a single space identically. Comparing them as
 * given would report spacing changes that may not exist in the documents.
 */
function linesOf(pageText: string | undefined): string[] {
  return (pageText ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
}

interface Section {
  page: number
  changes: DiffChange[]
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
    icon: 'git-compare',
    surface: 'canvas',
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
    const beforePages = await extractPdfText(before.path)
    const afterPages = await extractPdfText(after.path)
    onProgress?.(0.4)

    const pageCount = Math.max(beforePages.length, afterPages.length)
    const sections: Section[] = []
    let removed = 0
    let added = 0

    for (let index = 0; index < pageCount; index++) {
      const changes = diffLines(linesOf(beforePages[index]), linesOf(afterPages[index])).filter(
        (change) => change.kind !== 'same',
      )
      if (changes.length === 0) continue

      removed += changes.filter((change) => change.kind === 'removed').length
      added += changes.filter((change) => change.kind === 'added').length
      sections.push({ page: index + 1, changes })
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

    return [
      {
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { removed, added, pagesWithChanges: sections.length, pagesCompared: pageCount },
      },
    ]
  },
}
