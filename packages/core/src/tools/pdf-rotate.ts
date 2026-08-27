import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { degrees } from 'pdf-lib'
import { z } from 'zod'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const RotatePdfParams = z.object({
  // Coerced, because this is a dropdown and a browser submits "90" as text.
  angle: z.coerce
    .number()
    .int()
    .refine((v) => v === 90 || v === 180 || v === 270, { message: 'choose a quarter, half or three-quarter turn' })
    .default(90),
  pages: z.string().trim().max(400).optional(),
})

export type RotatePdfParams = z.infer<typeof RotatePdfParams>

export const rotatePdf: Tool<RotatePdfParams> = {
  id: 'rotate-pdf',
  title: 'Rotate PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: RotatePdfParams,
  ui: {
    group: 'organise',
    icon: 'rotate-cw',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Turn pages the right way up — all of them, or only the ones you name.',
    fields: [
      {
        name: 'angle',
        label: 'Rotation',
        kind: 'segmented',
        default: '90',
        options: [
          { value: '90', label: '90° right' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° left' },
        ],
      },
      { name: 'pages', label: 'Pages', kind: 'text', help: 'For example 1-3,5 — leave blank for every page.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const selected = new Set(parsePageRanges(params.pages, doc.getPageCount()))

      for (const page of selected) {
        const target = doc.getPage(page - 1)
        // Added to whatever rotation the page already carries, so a scanned
        // page that is already sideways ends up where the user expects.
        const current = target.getRotation().angle
        target.setRotation(degrees((current + params.angle) % 360))
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
