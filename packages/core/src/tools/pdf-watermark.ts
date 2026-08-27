import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { preparePdfText, type PdfTextMark } from '../pdf-draw-text.js'
import { uniqueName } from '../naming.js'
import { stripControlChars } from '../text.js'
import type { Tool } from '../registry.js'

/** Convert #rrggbb to the 0..1 components a mark expects. */
function toComponents(hex: string) {
  const value = hex.replace('#', '')
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  }
}

export const PdfWatermarkParams = z.object({
  text: z.string().trim().min(1).max(120),
  opacity: z.coerce.number().int().min(1).max(100).default(25),
  fontSize: z.coerce.number().int().min(8).max(200).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#c2410c'),
  rotation: z.coerce.number().min(-90).max(90).default(-30),
  tiled: z.boolean().default(false),
  /**
   * Where the mark's top left corner sits, as fractions of the page. Absent
   * means the middle, which is where a watermark goes unless someone moves it.
   * Ignored when tiled: a lattice covers the page regardless.
   */
  x: z.coerce.number().min(0).max(1).optional(),
  y: z.coerce.number().min(0).max(1).optional(),
  pages: z.string().trim().max(400).optional(),
})

export type PdfWatermarkParams = z.infer<typeof PdfWatermarkParams>

export const pdfWatermark: Tool<PdfWatermarkParams> = {
  id: 'pdf-watermark',
  title: 'Watermark PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfWatermarkParams,
  ui: {
    group: 'pdf-secure',
    icon: 'stamp',
    surface: 'pdfedit',
    pdfEdit: 'place',
    preview: 'none',
    blurb: 'Stamp text across a document before it leaves your hands. Drag the mark to where it should sit, or tile it over the whole page.',
    fields: [
      { name: 'text', label: 'Watermark text', kind: 'text', default: 'CONFIDENTIAL' },
      { name: 'tiled', label: 'Repeat across the whole page', kind: 'toggle', default: false },
      { name: 'opacity', label: 'Opacity (%)', kind: 'number', min: 1, max: 100, default: 25 },
      { name: 'color', label: 'Colour', kind: 'color', default: '#c2410c' },
      { name: 'fontSize', label: 'Text size', kind: 'number', min: 8, max: 200,
        help: 'Leave blank to scale with the page.' },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'Leave blank to mark every page.' },
      { name: 'x', label: 'From the left', kind: 'number', min: 0, max: 1, step: 0.01,
        help: 'Set by dragging the mark. Blank centres it.' },
      { name: 'y', label: 'From the top', kind: 'number', min: 0, max: 1, step: 0.01 },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []
    const opacity = params.opacity / 100
    const colour = toComponents(params.color)

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const selected = parsePageRanges(params.pages, doc.getPageCount())
      const text = stripControlChars(params.text)
      /**
       * Marks are prepared per type size and reused. Pages of one document are
       * usually the same size, and for text outside Latin-1 preparing a mark
       * means rendering it — not something to repeat 500 times.
       */
      const marks = new Map<number, PdfTextMark>()

      for (const pageNumber of selected) {
        const page = doc.getPage(pageNumber - 1)
        const { width, height } = page.getSize()
        const size = params.fontSize ?? Math.max(18, Math.round(width / 12))

        let mark = marks.get(size)
        if (!mark) {
          mark = await preparePdfText(doc, { text, size, colour, bold: true })
          marks.set(size, mark)
        }

        if (params.tiled) {
          /**
           * A diagonal lattice, which is the hardest pattern to crop out — so
           * it has to actually reach the edges. Both loops start one full step
           * outside the page and end one past it: starting half a step inside
           * left the top of every page unmarked, which is the first place
           * someone would crop.
           */
          const stepX = Math.max(mark.width * 1.4, 120)
          const stepY = Math.max(size * 3.2, 90)
          for (let y = -stepY; y < height + stepY; y += stepY) {
            for (let x = -stepX / 2; x < width + stepX; x += stepX) {
              mark.draw(page, { x, y, opacity, rotate: params.rotation })
            }
          }
        } else {
          // The mark is positioned by its top left corner, the way everything
          // placed on a page here is; PDF measures up from the bottom.
          const left = params.x === undefined ? (width - mark.width) / 2 : params.x * width
          const baseline =
            params.y === undefined ? height / 2 : height - params.y * height - mark.height
          mark.draw(page, { x: left, y: baseline, opacity, rotate: params.rotation })
        }
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
