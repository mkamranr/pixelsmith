import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rgb, StandardFonts } from 'pdf-lib'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import { stripControlChars } from '../text.js'
import type { Tool } from '../registry.js'

const POSITIONS = ['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right'] as const

export const PdfPageNumbersParams = z.object({
  position: z.enum(POSITIONS).default('bottom-center'),
  /** The number printed on the first selected page. */
  startAt: z.coerce.number().int().min(1).default(1),
  format: z.enum(['plain', 'of-total', 'page-n']).default('plain'),
  fontSize: z.coerce.number().int().min(6).max(48).default(11),
  margin: z.coerce.number().int().min(4).max(120).default(28),
  pages: z.string().trim().max(400).optional(),
})

export type PdfPageNumbersParams = z.infer<typeof PdfPageNumbersParams>

function labelFor(format: PdfPageNumbersParams['format'], number: number, total: number): string {
  if (format === 'of-total') return `${number} of ${total}`
  if (format === 'page-n') return `Page ${number}`
  return String(number)
}

export const pdfPageNumbers: Tool<PdfPageNumbersParams> = {
  id: 'pdf-page-numbers',
  title: 'Add page numbers',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfPageNumbersParams,
  ui: {
    group: 'pdf-edit',
    icon: 'message-square',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Stamp page numbers onto a document, in the corner or centre you choose.',
    fields: [
      {
        name: 'position',
        label: 'Position',
        kind: 'select',
        default: 'bottom-center',
        options: [
          { value: 'bottom-center', label: 'Bottom centre' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'top-center', label: 'Top centre' },
          { value: 'top-left', label: 'Top left' },
          { value: 'top-right', label: 'Top right' },
        ],
      },
      {
        name: 'format',
        label: 'Style',
        kind: 'select',
        default: 'plain',
        options: [
          { value: 'plain', label: 'Just the number — 3' },
          { value: 'of-total', label: 'With the total — 3 of 12' },
          { value: 'page-n', label: 'Worded — Page 3' },
        ],
      },
      { name: 'startAt', label: 'Start numbering at', kind: 'number', min: 1, default: 1 },
      { name: 'fontSize', label: 'Text size', kind: 'number', min: 6, max: 48, default: 11 },
      { name: 'margin', label: 'Distance from edge', kind: 'number', min: 4, max: 120, default: 28 },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'Leave blank to number every page.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const selected = parsePageRanges(params.pages, doc.getPageCount())

      for (const [order, pageNumber] of selected.entries()) {
        const page = doc.getPage(pageNumber - 1)
        const { width, height } = page.getSize()
        const label = stripControlChars(labelFor(params.format, params.startAt + order, selected.length))
        const textWidth = font.widthOfTextAtSize(label, params.fontSize)

        // PDF coordinates start at the bottom-left, which is why "top" adds to
        // the height rather than subtracting from it.
        const x = params.position.endsWith('left')
          ? params.margin
          : params.position.endsWith('right')
            ? width - params.margin - textWidth
            : (width - textWidth) / 2
        const y = params.position.startsWith('top')
          ? height - params.margin - params.fontSize
          : params.margin

        page.drawText(label, { x, y, size: params.fontSize, font, color: rgb(0.1, 0.1, 0.1) })
      }

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await doc.save())
      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
