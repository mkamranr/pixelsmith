import { copyFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'
import { runExternal } from '../external.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { renderPdfPages } from '../pdf-render.js'
import { uniqueName } from '../naming.js'
import type { OutputFile, Tool } from '../registry.js'

export const PdfCompressParams = z.object({
  /**
   * Two honest options rather than one vague slider.
   *
   * `lossless` restructures the file and keeps everything selectable, but the
   * saving is modest. `images` rebuilds each page as a picture, which shrinks a
   * scanned document dramatically at the cost of selectable text — so it is
   * named for what it does rather than sold as a quality setting.
   */
  mode: z.enum(['lossless', 'images']).default('lossless'),
  dpi: z.coerce.number().int().min(36).max(600).default(120),
  quality: z.coerce.number().int().min(20).max(95).default(70),
  grayscale: z.boolean().default(false),
})

export type PdfCompressParams = z.infer<typeof PdfCompressParams>

export const pdfCompress: Tool<PdfCompressParams> = {
  id: 'pdf-compress',
  title: 'Compress PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfCompressParams,
  ui: {
    group: 'pdf-optimize',
    icon: 'archive',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Make a document smaller — tidily, or by rebuilding scanned pages as pictures.',
    fields: [
      {
        name: 'mode',
        label: 'Method',
        kind: 'segmented',
        default: 'lossless',
        options: [
          { value: 'lossless', label: 'Tidy — keeps text' },
          { value: 'images', label: 'Rebuild pages as images' },
        ],
      },
      {
        name: 'dpi',
        label: 'Resolution',
        kind: 'select',
        default: '120',
        showWhen: { field: 'mode', equals: ['images'] },
        options: [
          { value: '72', label: 'Screen — 72 dpi, smallest' },
          { value: '120', label: 'Reading — 120 dpi' },
          { value: '200', label: 'Good — 200 dpi' },
          { value: '300', label: 'Print — 300 dpi' },
        ],
      },
      { name: 'quality', label: 'Image quality', kind: 'number', min: 20, max: 95, default: 70,
        showWhen: { field: 'mode', equals: ['images'] } },
      { name: 'grayscale', label: 'Convert to greyscale', kind: 'toggle', default: false,
        showWhen: { field: 'mode', equals: ['images'] },
        help: 'Much smaller for scanned text, and usually just as readable.' },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs: OutputFile[] = []

    for (const [index, input] of inputs.entries()) {
      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)

      if (params.mode === 'lossless') {
        /**
         * qpdf rewrites the file structure: shared objects, object streams and
         * a linearised layout. It does not touch image data, so text stays
         * selectable and the saving is structural.
         *
         * Exit code 3 means it succeeded but found recoverable problems, which
         * is a warning about the input, not a failure of the operation.
         */
        await runExternal('qpdf', settings.qpdfPath ?? 'qpdf', [
          '--linearize',
          '--object-streams=generate',
          input.path,
          dest,
        ], { successCodes: [0, 3] })
      } else {
        const doc = await loadPdf(input.path)
        const pageCount = doc.getPageCount()
        // Keep the original page geometry so the document still prints true.
        const sizes = Array.from({ length: pageCount }, (_, i) => doc.getPage(i).getSize())

        const rasters = await renderPdfPages(
          input.path,
          Array.from({ length: pageCount }, (_, i) => i + 1),
          { dpi: params.dpi },
        )

        const rebuilt = await PDFDocument.create()
        for (const [i, png] of rasters.entries()) {
          let image = sharp(png).flatten({ background: '#ffffff' })
          if (params.grayscale) image = image.greyscale()
          const jpeg = await image.jpeg({ quality: params.quality, mozjpeg: true }).toBuffer()

          const embedded = await rebuilt.embedJpg(jpeg)
          const size = sizes[i]!
          const page = rebuilt.addPage([size.width, size.height])
          page.drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height })
        }

        await writeFile(dest, await rebuilt.save())
      }

      const written = await stat(dest)
      // Never hand back something bigger than we were given: if the "smaller"
      // file is larger, the original is the better answer.
      if (written.size > input.bytes) {
        await copyFile(input.path, dest)
      }

      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
