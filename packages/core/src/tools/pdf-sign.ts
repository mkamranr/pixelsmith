import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'
import { BadInputError } from '../errors.js'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { preparePdfText } from '../pdf-draw-text.js'
import { stripControlChars } from '../text.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/** Type sizes outside this range stop looking like a signature. */
const MIN_SIZE = 8
const MAX_SIZE = 72

/** Size a name is measured at before being scaled to fit. */
const REFERENCE_SIZE = 100

const CAPTION_SIZE = 9
const CAPTION_GAP = 4

export const SignPdfParams = z
  .object({
    kind: z.enum(['image', 'text']).default('image'),
    /** The name to write, when signing without a scanned image. */
    text: z.string().trim().max(120).optional(),
    /** Small print under the mark — a printed name, a date, a role. */
    caption: z.string().trim().max(120).optional(),
    /** Blank means the last page, which is where a signature belongs. */
    pages: z.string().trim().max(400).optional(),
    /** Position of the mark's top left corner, as a fraction of the page. */
    x: z.coerce.number().min(0).max(1).default(0.6),
    y: z.coerce.number().min(0).max(1).default(0.8),
    /** How much of the page width the mark spans. */
    width: z.coerce.number().min(0.05).max(1).default(0.28),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'text' && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'type the name to sign with',
        path: ['text'],
      })
    }
  })

export type SignPdfParams = z.infer<typeof SignPdfParams>

export const signPdf: Tool<SignPdfParams> = {
  id: 'sign-pdf',
  title: 'Sign PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: SignPdfParams,
  ui: {
    group: 'pdf-secure',
    icon: 'pen-line',
    surface: 'pdfedit',
    pdfEdit: 'place',
    // A signature goes on one page, and by default the one being looked at.
    pdfScope: 'current',
    preview: 'none',
    blurb:
      'Place a signature on a document — a scanned image of your own, or your name set in type. The rest of the document is left exactly as it was.',
    fields: [
      { name: 'kind', label: 'Signature', kind: 'segmented', default: 'image',
        options: [
          { value: 'image', label: 'Scanned image' },
          { value: 'text', label: 'Typed name' },
        ] },
      { name: 'signatureFile', label: 'Signature image', kind: 'file',
        showWhen: { field: 'kind', equals: ['image'] },
        help: 'A PNG with a transparent background sits best on the page.' },
      { name: 'text', label: 'Name', kind: 'text',
        showWhen: { field: 'kind', equals: ['text'] } },
      { name: 'caption', label: 'Caption', kind: 'text',
        help: 'Optional small print under the signature, such as a printed name or date.' },
      { name: 'pages', label: 'Pages', kind: 'text',
        help: 'Leave blank to sign the last page.' },
      { name: 'width', label: 'Width of the signature', kind: 'range', min: 0.05, max: 1, step: 0.01, default: 0.28 },
      { name: 'x', label: 'From the left', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
      { name: 'y', label: 'From the top', kind: 'range', min: 0, max: 1, step: 0.01, default: 0.8 },
    ],
  },

  async run({ inputs, outDir, params, assets, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const pageCount = doc.getPageCount()
      const selected =
        params.pages && params.pages.trim() !== ''
          ? parsePageRanges(params.pages, pageCount)
          : [pageCount]

      // Oblique, because a signature set in an upright face reads as a label.
      // Only reachable for text the standard fonts can encode; anything else
      // goes through preparePdfText, which shapes it properly.
      const signatureFont = await doc.embedFont(StandardFonts.HelveticaOblique)

      let embedded: Awaited<ReturnType<typeof doc.embedPng>> | undefined
      if (params.kind === 'image') {
        const source = assets.signatureFile
        if (!source) {
          throw new BadInputError('choose a signature image, or switch to a typed signature')
        }
        // Normalised through sharp so any accepted image format arrives as a
        // PNG with an alpha channel, whatever the user uploaded.
        embedded = await doc.embedPng(await sharp(source).ensureAlpha().png().toBuffer())
      }

      for (const pageNumber of selected) {
        const page = doc.getPage(pageNumber - 1)
        const { width: pageWidth, height: pageHeight } = page.getSize()
        const markWidth = params.width * pageWidth
        const left = params.x * pageWidth
        // The browser places the mark by its top left corner; PDF measures from
        // the bottom, so the height of the mark is needed before it can be put
        // anywhere.
        const fromTop = params.y * pageHeight
        let markHeight: number

        if (embedded) {
          markHeight = markWidth * (embedded.height / embedded.width)
          page.drawImage(embedded, {
            x: left,
            y: pageHeight - fromTop - markHeight,
            width: markWidth,
            height: markHeight,
          })
        } else {
          const text = stripControlChars(params.text!)
          /**
           * Set the name to span the requested width: measure a mark at a
           * reference size, then prepare the real one at the size that fits.
           * Measuring cannot use font metrics directly, because a name in
           * Arabic never reaches the standard font at all.
           */
          const reference = await preparePdfText(doc, { text, size: REFERENCE_SIZE })
          const size = Math.min(
            MAX_SIZE,
            Math.max(MIN_SIZE, (markWidth / reference.width) * REFERENCE_SIZE),
          )
          const mark = await preparePdfText(doc, { text, size })
          markHeight = mark.height
          mark.draw(page, { x: left, y: pageHeight - fromTop - markHeight })
        }

        if (params.caption) {
          const caption = await preparePdfText(doc, {
            text: stripControlChars(params.caption),
            size: CAPTION_SIZE,
            colour: { r: 0.35, g: 0.35, b: 0.35 },
          })
          caption.draw(page, {
            x: left,
            y: pageHeight - fromTop - markHeight - CAPTION_SIZE - CAPTION_GAP,
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
