import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { renderPdfPages } from '../pdf-render.js'
import { deriveName, uniqueName } from '../naming.js'
import { MIME_BY_FORMAT } from '../pipeline.js'
import type { OutputFile, Tool } from '../registry.js'

export const PdfToImageParams = z.object({
  format: z.enum(['jpeg', 'png']).default('jpeg'),
  /** Resolution to rasterise at. 150 is comfortable for screen and print draft. */
  dpi: z.coerce.number().int().min(36).max(600).default(150),
  quality: z.coerce.number().int().min(1).max(100).default(90),
  pages: z.string().trim().max(400).optional(),
})

export type PdfToImageParams = z.infer<typeof PdfToImageParams>

export const pdfToImage: Tool<PdfToImageParams> = {
  id: 'pdf-to-image',
  title: 'PDF to JPG',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfToImageParams,
  ui: {
    group: 'pdf-convert',
    icon: 'file-image',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Turn every page of a document into a picture.',
    fields: [
      {
        name: 'format',
        label: 'Image format',
        kind: 'segmented',
        default: 'jpeg',
        options: [
          { value: 'jpeg', label: 'JPG' },
          { value: 'png', label: 'PNG' },
        ],
      },
      {
        name: 'dpi',
        label: 'Resolution',
        kind: 'select',
        default: '150',
        options: [
          { value: '72', label: 'Screen — 72 dpi' },
          { value: '150', label: 'Standard — 150 dpi' },
          { value: '300', label: 'Print — 300 dpi' },
          { value: '600', label: 'Archive — 600 dpi' },
        ],
      },
      { name: 'quality', label: 'JPG quality', kind: 'number', min: 1, max: 100, default: 90,
        showWhen: { field: 'format', equals: ['jpeg'] } },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'For example 1-3,5 — leave blank for every page.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs: OutputFile[] = []
    const ext = params.format === 'jpeg' ? 'jpg' : 'png'

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const selected = parsePageRanges(params.pages, doc.getPageCount())

      const rasters = await renderPdfPages(input.path, selected, { dpi: params.dpi })

      for (const [i, png] of rasters.entries()) {
        const pageNumber = selected[i]!
        const name = uniqueName(taken, deriveName(input.name, { ext, suffix: `-page-${pageNumber}` }))
        const dest = join(outDir, name)

        // pdf.js always hands back PNG; sharp does the final encode so JPG
        // quality and metadata stripping behave exactly as they do elsewhere.
        const image = sharp(png)
        if (params.format === 'jpeg') {
          await image.flatten({ background: '#ffffff' }).jpeg({ quality: params.quality, mozjpeg: true }).toFile(dest)
        } else {
          await image.png({ compressionLevel: 9 }).toFile(dest)
        }

        outputs.push({
          path: dest,
          name,
          mime: MIME_BY_FORMAT[params.format]!,
          bytes: (await stat(dest)).size,
        })
      }

      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
