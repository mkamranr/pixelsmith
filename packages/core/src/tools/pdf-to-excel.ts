import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { extractPdfRows } from '../pdf-text.js'
import { convertWithLibreOffice } from '../soffice.js'
import { deriveName, uniqueName } from '../naming.js'
import { OOXML_MIMES } from './pdf-to-office.js'
import type { Tool } from '../registry.js'

/**
 * The CSV import filter, spelled out rather than left to LibreOffice's
 * guesswork: comma-separated, double-quoted, UTF-8 (charset 76), from row 1.
 * Guessing goes wrong on a document containing semicolons, and getting the
 * charset wrong turns Arabic into mojibake.
 */
const CSV_IMPORT_FILTER = 'Text - txt - csv (StarCalc):44,34,76,1'

export const PdfToExcelParams = z.object({})

export type PdfToExcelParams = z.infer<typeof PdfToExcelParams>

/** One CSV field, quoted only when it would otherwise break the row apart. */
function csvField(value: string): string {
  const needsQuotes = /[",\n\r]/.test(value) || value !== value.trim()
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value
}

export const pdfToExcel: Tool<PdfToExcelParams> = {
  id: 'pdf-to-excel',
  title: 'PDF to Excel',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfToExcelParams,
  ui: {
    group: 'pdf-convert',
    icon: 'table',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Pull the text of a PDF into a spreadsheet. Each line becomes a row, and columns are recovered from the gaps between them — so a real table comes through as a table. The first column is the page the row came from.',
    fields: [],
  },

  async run({ inputs, outDir, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      /**
       * LibreOffice has no PDF-to-spreadsheet export at all — asking for one
       * answers "no export filter". So the text is read out here, laid out as
       * rows, and handed over as CSV, which LibreOffice does convert.
       */
      const pages = await extractPdfRows(input.path)
      const lines = pages.flatMap((rows, page) =>
        rows.map((cells) => [String(page + 1), ...cells].map(csvField).join(',')),
      )

      const work = await mkdtemp(join(tmpdir(), 'pixelsmith-xl-'))

      try {
        const base = deriveName(input.name, { ext: 'csv' })
        const csv = join(work, base)
        // A trailing newline, so the last row is not left dangling.
        await writeFile(csv, `${lines.join('\n')}\n`, 'utf8')

        const name = uniqueName(taken, deriveName(input.name, { ext: 'xlsx' }))
        const dest = join(outDir, name)

        await convertWithLibreOffice(settings, csv, dest, {
          target: 'xlsx',
          extension: 'xlsx',
          infilter: CSV_IMPORT_FILTER,
        })

        outputs.push({ path: dest, name, mime: OOXML_MIMES.xlsx, bytes: (await stat(dest)).size })
      } finally {
        await rm(work, { recursive: true, force: true })
      }

      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
