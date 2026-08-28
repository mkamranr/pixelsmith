import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { rgb } from 'pdf-lib'
import sharp from 'sharp'
import { z } from 'zod'

import { BadInputError } from '../errors.js'
import { HANDWRITING_FACES, handwritingFace } from '../fonts.js'
import { uniqueName } from '../naming.js'
import { preparePdfText } from '../pdf-draw-text.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'
import { stripControlChars } from '../text.js'

/** Ink and paint colours, in the components pdf-lib works in. */
const PAINT: Record<string, { r: number; g: number; b: number }> = {
  black: { r: 0.1, g: 0.1, b: 0.12 },
  blue: { r: 0.09, g: 0.19, b: 0.55 },
  red: { r: 0.72, g: 0.13, b: 0.13 },
  green: { r: 0.08, g: 0.36, b: 0.19 },
  yellow: { r: 0.98, g: 0.85, b: 0.2 },
  white: { r: 1, g: 1, b: 1 },
}

/**
 * One thing placed on one page.
 *
 * Positions are fractions of the page rather than points, the same as cropping,
 * signing and watermarking: a fraction survives a document whose pages are not
 * the size you assumed, and it is what dragging on a rendered page produces.
 */
export const EditItem = z.object({
  kind: z.enum(['text', 'box', 'image']),
  page: z.coerce.number().int().min(1),
  x: z.coerce.number().min(0).max(1),
  y: z.coerce.number().min(0).max(1),
  /** For a box or a picture. A picture with no height keeps its proportions. */
  width: z.coerce.number().min(0.005).max(1).optional(),
  height: z.coerce.number().min(0.005).max(1).optional(),
  text: z.string().max(2_000).optional(),
  /** Type size in points, so text stays legible whatever the page size. */
  size: z.coerce.number().min(4).max(300).optional(),
  colour: z.enum(['black', 'blue', 'red', 'green', 'yellow', 'white']).default('black'),
  opacity: z.coerce.number().min(0.05).max(1).default(1),
  /** A handwriting face, which is what initialling a page amounts to. */
  face: z.enum(Object.keys(HANDWRITING_FACES) as [string, ...string[]]).optional(),
  /** A frame rather than a block. */
  outline: z.coerce.boolean().default(false),
})

export type EditItem = z.infer<typeof EditItem>

export const EditPdfParams = z.object({
  /**
   * What to draw, as JSON. Written by the page as things are placed on it, or
   * supplied directly by a script.
   */
  items: z.string().trim().min(3, { message: 'nothing to draw' }).max(200_000),
})

export type EditPdfParams = z.infer<typeof EditPdfParams>

const DEFAULT_TEXT_SIZE = 12

export const editPdf: Tool<EditPdfParams> = {
  id: 'edit-pdf',
  title: 'Edit PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: EditPdfParams,
  ui: {
    group: 'pdf-edit',
    icon: 'pen-line',
    surface: 'pdfedit',
    pdfEdit: 'items',
    pdfScope: 'current',
    preview: 'none',
    blurb:
      'Add to a page without rebuilding it: words, a box to frame or hide something, a highlight to draw the eye, or a picture such as a stamp. What was already on the page stays exactly as it was.',
    fields: [
      {
        // Written by the page as things are placed. Declared, because a value
        // that exists only in the schema is dropped at intake.
        name: 'items',
        label: 'What to draw',
        kind: 'hidden',
      },
      {
        name: 'image',
        label: 'Picture to place',
        kind: 'file',
        help: 'A stamp or a logo. One picture, which any number of placements can use.',
      },
    ],
  },

  async run({ inputs, outDir, params, assets, onProgress }) {
    let items: EditItem[]
    try {
      const parsed: unknown = JSON.parse(params.items)
      items = z.array(EditItem).max(500).parse(parsed)
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadInputError(`something placed on the page is not valid: ${err.issues[0]?.message}`)
      }
      throw new BadInputError('what to draw could not be read')
    }

    if (items.length === 0) throw new BadInputError('nothing was placed on the page')

    for (const item of items) {
      if (item.kind === 'text' && !item.text?.trim()) {
        throw new BadInputError('a piece of text was placed with no words in it')
      }
      if (item.kind === 'box' && (!item.width || !item.height)) {
        throw new BadInputError('a box was placed with no size')
      }
      if (item.kind === 'image' && !item.width) {
        throw new BadInputError('a picture was placed with no width')
      }
    }

    const picture = assets.image
    if (items.some((item) => item.kind === 'image') && !picture) {
      throw new BadInputError('a picture was placed, but no picture was supplied')
    }

    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const count = doc.getPageCount()

      const beyond = items.find((item) => item.page > count)
      if (beyond) {
        throw new BadInputError(
          `page ${beyond.page} is past the end of ${input.name}, which has ${count}`,
        )
      }

      /**
       * Embedded once even if placed many times: the same stamp in six corners
       * should not be six copies of the same picture in the file.
       */
      let embedded: Awaited<ReturnType<typeof doc.embedPng>> | undefined
      if (picture) {
        // pdf-lib embeds PNG and JPEG only, and orientation is baked in on the
        // way through as everywhere else.
        const bytes = await sharp(await readFile(picture)).autoOrient().png().toBuffer()
        embedded = await doc.embedPng(bytes)
      }

      for (const item of items) {
        const page = doc.getPage(item.page - 1)
        const { width: pageWidth, height: pageHeight } = page.getSize()
        const colour = PAINT[item.colour] ?? PAINT.black!
        const left = item.x * pageWidth
        // Items are placed from the top, because that is how a page is read and
        // how a browser reports a position; PDF measures up from the bottom.
        const fromTop = item.y * pageHeight

        if (item.kind === 'text') {
          const face = handwritingFace(item.face)
          const size = item.size ?? DEFAULT_TEXT_SIZE
          const mark = await preparePdfText(doc, {
            text: stripControlChars(item.text!),
            size,
            colour,
            ...(face ? { family: face.family } : {}),
          })
          mark.draw(page, {
            x: left,
            y: pageHeight - fromTop - mark.height,
            ...(item.opacity < 1 ? { opacity: item.opacity } : {}),
          })
          continue
        }

        if (item.kind === 'box') {
          const boxWidth = item.width! * pageWidth
          const boxHeight = item.height! * pageHeight
          page.drawRectangle({
            x: left,
            y: pageHeight - fromTop - boxHeight,
            width: boxWidth,
            height: boxHeight,
            ...(item.outline
              ? { borderColor: rgb(colour.r, colour.g, colour.b), borderWidth: 1.5 }
              : { color: rgb(colour.r, colour.g, colour.b) }),
            ...(item.opacity < 1
              ? item.outline
                ? { borderOpacity: item.opacity }
                : { opacity: item.opacity }
              : {}),
          })
          continue
        }

        const drawWidth = item.width! * pageWidth
        // Keeps its proportions unless a height was asked for.
        const drawHeight = item.height
          ? item.height * pageHeight
          : (embedded!.height / embedded!.width) * drawWidth
        page.drawImage(embedded!, {
          x: left,
          y: pageHeight - fromTop - drawHeight,
          width: drawWidth,
          height: drawHeight,
          ...(item.opacity < 1 ? { opacity: item.opacity } : {}),
        })
      }

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await doc.save())
      outputs.push({
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { items: items.length, pages: count },
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
