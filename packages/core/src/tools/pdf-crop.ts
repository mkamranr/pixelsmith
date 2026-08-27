import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

const fraction = z.coerce.number().min(0).max(1)

export const PdfCropParams = z
  .object({
    x: fraction.default(0),
    y: fraction.default(0),
    width: fraction.default(1),
    height: fraction.default(1),
    pages: z.string().trim().max(400).optional(),
  })
  .superRefine((v, ctx) => {
    // Refused rather than clamped: a crop that quietly keeps a different area
    // than asked for is worse than being told the numbers do not fit.
    if (v.width <= 0 || v.height <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'the area must have a size' })
    }
    if (v.x + v.width > 1.0001) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'the area runs off the right edge' })
    }
    if (v.y + v.height > 1.0001) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['height'], message: 'the area runs off the bottom edge' })
    }
  })

export type PdfCropParams = z.infer<typeof PdfCropParams>

export const pdfCrop: Tool<PdfCropParams> = {
  id: 'pdf-crop',
  title: 'Crop PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfCropParams,
  ui: {
    group: 'pdf-edit',
    icon: 'crop',
    surface: 'pdfedit',
    pdfEdit: 'crop',
    preview: 'none',
    blurb: 'Drag on the page to choose the area to keep. Apply it to every page or just the one on screen.',
    fields: [
      { name: 'x', label: 'Left edge', kind: 'number', min: 0, max: 1, step: 0.01, default: 0,
        help: 'Set by dragging on the page. As a fraction of the width: 0 is the left edge.' },
      { name: 'y', label: 'Top edge', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
      { name: 'width', label: 'Width', kind: 'number', min: 0.01, max: 1, step: 0.01, default: 1 },
      { name: 'height', label: 'Height', kind: 'number', min: 0.01, max: 1, step: 0.01, default: 1 },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'Leave blank to crop every page.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const selected = parsePageRanges(params.pages, doc.getPageCount())

      for (const pageNumber of selected) {
        const page = doc.getPage(pageNumber - 1)
        const { width, height } = page.getSize()

        const boxWidth = params.width * width
        const boxHeight = params.height * height
        const left = params.x * width
        // The fractions are measured from the top, the way a person reads a
        // page; PDF boxes are measured from the bottom.
        const bottom = (1 - params.y - params.height) * height

        page.setMediaBox(left, bottom, boxWidth, boxHeight)
        page.setCropBox(left, bottom, boxWidth, boxHeight)
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
