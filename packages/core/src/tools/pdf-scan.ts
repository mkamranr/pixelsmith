import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'

import { RASTER_MIMES } from '../pipeline.js'
import { PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'

export const ScanPdfParams = z.object({
  /**
   * `grey` is what a document scanner produces and what most people want.
   * `mono` is a fax: smallest, and unforgiving of faint pencil. `colour` keeps
   * a stamp or a signature in ink.
   */
  mode: z.enum(['grey', 'mono', 'colour']).default('grey'),
  /** Whiten the paper and deepen the writing. The reason the tool exists. */
  enhance: z.coerce.boolean().default(true),
  /** Cut off whatever the page was lying on. */
  trim: z.coerce.boolean().default(true),
  filename: z.string().trim().max(120).default('scan'),
})

export type ScanPdfParams = z.infer<typeof ScanPdfParams>

/** How much darker than the paper a pixel must be to survive thresholding. */
const MONO_THRESHOLD = 150

export const scanPdf: Tool<ScanPdfParams> = {
  id: 'scan-pdf',
  title: 'Scan to PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: ScanPdfParams,
  ui: {
    group: 'pdf-convert',
    icon: 'scan-text',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Photographs of pages into a document that looks scanned rather than photographed: the paper whitened, the writing deepened, and the desk around the edges cut away.',
    fields: [
      {
        name: 'mode',
        label: 'Colour',
        kind: 'segmented',
        default: 'grey',
        options: [
          { value: 'grey', label: 'Greyscale' },
          { value: 'mono', label: 'Black and white' },
          { value: 'colour', label: 'Keep colour' },
        ],
      },
      {
        name: 'enhance',
        label: 'Whiten the paper',
        kind: 'toggle',
        default: true,
        help: 'Stretches the tones so paper reads as white and writing as black.',
      },
      {
        name: 'trim',
        label: 'Cut away the surround',
        kind: 'toggle',
        default: true,
        help: 'Removes the darker border where the desk shows around the page.',
      },
      { name: 'filename', label: 'Name the document', kind: 'text', default: 'scan' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const doc = await PDFDocument.create()

    for (const [index, input] of inputs.entries()) {
      // Orientation first: a phone stores a portrait photograph as landscape
      // pixels plus a flag, and every later step works on the pixels.
      let picture = sharp(input.path).autoOrient()

      if (params.trim) {
        /**
         * The page is the bright rectangle; the surround is darker. trim()
         * removes a border similar to the corner pixel, which is the desk.
         * Tolerant threshold, because a photograph's border is never uniform.
         */
        picture = picture.trim({ threshold: 24 })
      }

      if (params.mode !== 'colour') picture = picture.greyscale()

      if (params.enhance) {
        // normalise stretches the tones so the lightest become white; a little
        // gamma keeps the writing from thinning out as the paper brightens.
        picture = picture.normalise().gamma(1.1)
      }

      if (params.mode === 'mono') picture = picture.threshold(MONO_THRESHOLD)

      /**
       * JPEG for a photograph, and quality high enough that thresholded text
       * does not acquire a halo. pdf-lib embeds JPEG and PNG only.
       */
      const bytes = await picture.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
      const embedded = await doc.embedJpg(bytes)

      // One point per pixel: the page takes the shape of the photograph, which
      // is what a scan of an unknown paper size can honestly claim.
      const page = doc.addPage([embedded.width, embedded.height])
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height })

      onProgress?.((index + 1) / inputs.length)
    }

    const name = `${params.filename.replace(/[^\w\- ]+/g, '').trim() || 'scan'}.pdf`
    const dest = join(outDir, name)
    await writeFile(dest, await doc.save())

    return [
      {
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { pages: inputs.length, mode: params.mode },
      },
    ]
  },
}
