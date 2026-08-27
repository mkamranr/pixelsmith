import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, degrees } from 'pdf-lib'
import { z } from 'zod'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { stem } from '../naming.js'
import type { Tool } from '../registry.js'

/** PDF page rotation is stored in quarter turns, and nothing else is valid. */
const QUARTER_TURNS = [0, 90, 180, 270]

/**
 * Read the per-file turns: one quarter turn per input, in the same order, as in
 * `0,90,0`. Anything missing is no turn, so the list can be shorter than the
 * batch and an untouched merge can send nothing at all.
 */
export function parseRotations(raw: string | undefined): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(Number)
}

export const MergePdfParams = z.object({
  /** Name for the combined document, without an extension. */
  filename: z.string().trim().max(120).default('merged'),
  /**
   * A quarter turn per file, in merge order. Held as one field because that is
   * what a form can carry, and because the turn belongs to the file rather than
   * to the job: one sideways scan among five upright documents is the normal
   * case.
   */
  rotations: z
    .string()
    .trim()
    .max(400)
    .default('')
    .refine(
      (raw) => parseRotations(raw).every((turn) => QUARTER_TURNS.includes(turn)),
      { message: 'each turn must be 0, 90, 180 or 270 degrees' },
    ),
})

export type MergePdfParams = z.infer<typeof MergePdfParams>

export const mergePdf: Tool<MergePdfParams> = {
  id: 'merge-pdf',
  title: 'Merge PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: MergePdfParams,
  ui: {
    group: 'organise',
    icon: 'merge',
    surface: 'canvas',
    pdfView: 'files',
    preview: 'none',
    blurb: 'Combine several PDFs into one document, in the order you choose. Drag to reorder, and turn any document that arrived sideways.',
    fields: [
      { name: 'filename', label: 'Name the result', kind: 'text', default: 'merged' },
      // Written by the workspace as documents are turned and reordered.
      { name: 'rotations', label: 'Rotations', kind: 'hidden' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const merged = await PDFDocument.create()
    const rotations = parseRotations(params.rotations)

    // Input order is the document order, which is why the upload list is
    // reorderable in the interface.
    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const pages = await merged.copyPages(source, source.getPageIndices())
      const turn = rotations[index] ?? 0

      for (const page of pages) {
        if (turn !== 0) {
          // Added to what the page already carries: a scan saved sideways is
          // already at 90, and another quarter turn makes 180.
          const angle = page.getRotation().angle
          page.setRotation(degrees((((angle + turn) % 360) + 360) % 360))
        }
        merged.addPage(page)
      }

      onProgress?.((index + 1) / inputs.length)
    }

    const name = `${stem(params.filename || 'merged') || 'merged'}.pdf`
    const dest = join(outDir, name)
    await writeFile(dest, await merged.save())

    return [{ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size }]
  },
}
