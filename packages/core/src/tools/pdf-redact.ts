import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'
import { BadInputError } from '../errors.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { renderPdfPages } from '../pdf-render.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/**
 * A box to black out, as fractions of the page measured from the top left.
 *
 * Fractions rather than pixels, because the browser marks these on a thumbnail
 * of whatever size happens to fit the screen, and the server redacts the page
 * at full resolution. Pixels would tie the two together.
 */
export const RedactBox = z.object({
  page: z.coerce.number().int().positive(),
  x: z.coerce.number().min(0).max(1),
  y: z.coerce.number().min(0).max(1),
  width: z.coerce.number().gt(0).max(1),
  height: z.coerce.number().gt(0).max(1),
})

export type RedactBox = z.infer<typeof RedactBox>

/** Lenient parse used during validation; the strict one runs in `run`. */
function parseBoxesOrEmpty(raw: string | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Strict parse. A list we cannot read is an error, never an empty list. */
export function parseRedactBoxes(raw: string): RedactBox[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new BadInputError('the marked areas could not be read')
  }

  const parsed = z.array(RedactBox).min(1).max(500).safeParse(json)
  if (!parsed.success) {
    throw new BadInputError(
      `a marked area is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    )
  }
  return parsed.data
}

export const RedactPdfParams = z
  .object({
    regions: z.string().max(200_000),
    /**
     * The resolution the redacted document is rebuilt at. 150 keeps text
     * comfortably readable at print size without tripling the file size.
     */
    dpi: z.coerce.number().int().min(72).max(300).default(150),
  })
  .superRefine((value, ctx) => {
    if (parseBoxesOrEmpty(value.regions).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mark at least one area to redact',
        path: ['regions'],
      })
    }
  })

export type RedactPdfParams = z.infer<typeof RedactPdfParams>

export const redactPdf: Tool<RedactPdfParams> = {
  id: 'redact-pdf',
  title: 'Redact PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: RedactPdfParams,
  ui: {
    group: 'pdf-secure',
    icon: 'square-slash',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Black out anything that must not leave the building. Every page is rebuilt as an image, so the hidden words are genuinely gone from the file and not merely covered — which also means the document is no longer searchable. Run OCR PDF afterwards if you need that back.',
    fields: [
      { name: 'regions', label: 'Marked areas', kind: 'textarea',
        help: 'Drag on a page to mark what to remove.' },
      { name: 'dpi', label: 'Rebuild detail (dpi)', kind: 'number', min: 72, max: 300, default: 150,
        help: 'Higher keeps small print sharper and makes a larger file.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []
    const boxes = parseRedactBoxes(params.regions)

    for (const input of inputs) {
      const source = await loadPdf(input.path)
      const pageCount = source.getPageCount()

      for (const box of boxes) {
        if (box.page > pageCount) {
          throw new BadInputError(`page ${box.page} is not in this ${pageCount}-page document`)
        }
      }

      /**
       * Rasterising is what makes this real redaction. pdf-lib can draw over a
       * content stream but cannot remove text from one, and text under a black
       * rectangle is still text: selectable, searchable, and extractable by
       * anyone who opens the file. Rendering each page to an image discards
       * every glyph, and the black boxes are then painted onto pixels.
       */
      const redacted = await PDFDocument.create()

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        const sourcePage = source.getPage(pageNumber - 1)
        const { width, height } = sourcePage.getSize()
        // pdf.js renders a rotated page upright, so the image is landscape
        // where the mediabox is portrait. The new page has to match the image.
        const quarterTurned = Math.abs(sourcePage.getRotation().angle / 90) % 2 === 1
        const pageWidth = quarterTurned ? height : width
        const pageHeight = quarterTurned ? width : height

        const [png] = await renderPdfPages(input.path, [pageNumber], { dpi: params.dpi })
        let image = sharp(png!)
        const meta = await image.metadata()

        const here = boxes.filter((box) => box.page === pageNumber)
        if (here.length > 0) {
          image = image.composite(
            here.map((box) => {
              const left = Math.min(Math.round(box.x * meta.width!), meta.width! - 1)
              const top = Math.min(Math.round(box.y * meta.height!), meta.height! - 1)
              return {
                input: {
                  create: {
                    width: Math.max(1, Math.min(Math.round(box.width * meta.width!), meta.width! - left)),
                    height: Math.max(1, Math.min(Math.round(box.height * meta.height!), meta.height! - top)),
                    channels: 4 as const,
                    background: { r: 0, g: 0, b: 0, alpha: 1 },
                  },
                },
                left,
                top,
              }
            }),
          )
        }

        const embedded = await redacted.embedPng(await image.png().toBuffer())
        redacted
          .addPage([pageWidth, pageHeight])
          .drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight })

        onProgress?.(pageNumber / pageCount)
      }

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await redacted.save())
      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
    }

    return outputs
  },
}
