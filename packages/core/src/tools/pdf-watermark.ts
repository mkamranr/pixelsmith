import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { degrees, rgb, StandardFonts } from 'pdf-lib'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import { stripControlChars } from '../text.js'
import type { Tool } from '../registry.js'

/** Convert #rrggbb to the 0..1 components pdf-lib expects. */
function toRgb(hex: string) {
  const value = hex.replace('#', '')
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  )
}

export const PdfWatermarkParams = z.object({
  text: z.string().trim().min(1).max(120),
  opacity: z.coerce.number().int().min(1).max(100).default(25),
  fontSize: z.coerce.number().int().min(8).max(200).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#c2410c'),
  rotation: z.coerce.number().min(-90).max(90).default(-30),
  tiled: z.boolean().default(false),
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
    surface: 'canvas',
    preview: 'none',
    blurb: 'Stamp text across every page before a document leaves your hands.',
    fields: [
      { name: 'text', label: 'Watermark text', kind: 'text', default: 'CONFIDENTIAL' },
      { name: 'tiled', label: 'Repeat across the whole page', kind: 'toggle', default: false },
      { name: 'opacity', label: 'Opacity (%)', kind: 'number', min: 1, max: 100, default: 25 },
      { name: 'color', label: 'Colour', kind: 'color', default: '#c2410c' },
      { name: 'fontSize', label: 'Text size', kind: 'number', min: 8, max: 200,
        help: 'Leave blank to scale with the page.' },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'Leave blank to mark every page.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []
    const opacity = params.opacity / 100
    const colour = toRgb(params.color)

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const font = await doc.embedFont(StandardFonts.HelveticaBold)
      const selected = parsePageRanges(params.pages, doc.getPageCount())
      const text = stripControlChars(params.text)

      for (const pageNumber of selected) {
        const page = doc.getPage(pageNumber - 1)
        const { width, height } = page.getSize()
        const size = params.fontSize ?? Math.max(18, Math.round(width / 12))
        const textWidth = font.widthOfTextAtSize(text, size)

        if (params.tiled) {
          /**
           * A diagonal lattice, which is the hardest pattern to crop out — so
           * it has to actually reach the edges. Both loops start one full step
           * outside the page and end one past it: starting half a step inside
           * left the top of every page unmarked, which is the first place
           * someone would crop.
           */
          const stepX = Math.max(textWidth * 1.4, 120)
          const stepY = Math.max(size * 3.2, 90)
          for (let y = -stepY; y < height + stepY; y += stepY) {
            for (let x = -stepX / 2; x < width + stepX; x += stepX) {
              page.drawText(text, {
                x, y, size, font, color: colour, opacity, rotate: degrees(params.rotation),
              })
            }
          }
        } else {
          page.drawText(text, {
            x: (width - textWidth) / 2,
            y: height / 2,
            size,
            font,
            color: colour,
            opacity,
            rotate: degrees(params.rotation),
          })
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
