import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { stem } from '../naming.js'
import { RASTER_MIMES } from '../pipeline.js'
import type { Tool } from '../registry.js'

/** Paper sizes in PDF points (72 per inch). */
const PAPER = {
  a4: [595.28, 841.89],
  letter: [612, 792],
} as const

export const ImagesToPdfParams = z.object({
  pageSize: z.enum(['fit', 'a4', 'letter']).default('fit'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  margin: z.coerce.number().int().min(0).max(150).default(24),
  filename: z.string().trim().max(120).default('document'),
})

export type ImagesToPdfParams = z.infer<typeof ImagesToPdfParams>

export const imagesToPdf: Tool<ImagesToPdfParams> = {
  id: 'images-to-pdf',
  title: 'JPG to PDF',
  family: 'pdf',
  queue: 'image',
  // Lives in the PDF menu but consumes pictures, which is why the family and
  // the accepted types differ here.
  accepts: [...RASTER_MIMES],
  params: ImagesToPdfParams,
  ui: {
    group: 'pdf-convert',
    icon: 'file-image',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Turn pictures into a PDF, one page per image.',
    fields: [
      {
        name: 'pageSize',
        label: 'Page size',
        kind: 'segmented',
        default: 'fit',
        options: [
          { value: 'fit', label: 'Fit the image' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
        ],
      },
      {
        name: 'orientation',
        label: 'Orientation',
        kind: 'select',
        default: 'portrait',
        showWhen: { field: 'pageSize', equals: ['a4', 'letter'] },
        options: [
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
      },
      { name: 'margin', label: 'Margin (pt)', kind: 'number', min: 0, max: 150, default: 24,
        showWhen: { field: 'pageSize', equals: ['a4', 'letter'] } },
      { name: 'filename', label: 'Name the result', kind: 'text', default: 'document' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const doc = await PDFDocument.create()

    for (const [index, input] of inputs.entries()) {
      // pdf-lib embeds JPEG and PNG only, so anything else is converted first.
      // Orientation is baked in on the way through, as everywhere else.
      const isJpeg = input.mime === 'image/jpeg'
      const bytes = isJpeg
        ? await readFile(input.path)
        : await sharp(input.path).autoOrient().png().toBuffer()

      const embedded = isJpeg
        ? await doc.embedJpg(await sharp(input.path).autoOrient().jpeg({ quality: 92 }).toBuffer())
        : await doc.embedPng(bytes)

      if (params.pageSize === 'fit') {
        // One point per pixel: the page takes the shape of the picture.
        const page = doc.addPage([embedded.width, embedded.height])
        page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height })
      } else {
        const [shortSide, longSide] = PAPER[params.pageSize]
        const [pageWidth, pageHeight] =
          params.orientation === 'landscape' ? [longSide, shortSide] : [shortSide, longSide]

        const page = doc.addPage([pageWidth, pageHeight])
        const usableWidth = Math.max(1, pageWidth - params.margin * 2)
        const usableHeight = Math.max(1, pageHeight - params.margin * 2)
        const scale = Math.min(usableWidth / embedded.width, usableHeight / embedded.height)
        const drawWidth = embedded.width * scale
        const drawHeight = embedded.height * scale

        page.drawImage(embedded, {
          x: (pageWidth - drawWidth) / 2,
          y: (pageHeight - drawHeight) / 2,
          width: drawWidth,
          height: drawHeight,
        })
      }

      onProgress?.((index + 1) / inputs.length)
    }

    const name = `${stem(params.filename || 'document') || 'document'}.pdf`
    const dest = join(outDir, name)
    await writeFile(dest, await doc.save())

    return [{ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size }]
  },
}
