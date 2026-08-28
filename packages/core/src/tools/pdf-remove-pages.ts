import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { BadInputError } from '../errors.js'
import { uniqueName } from '../naming.js'
import { parsePageRanges } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import type { Tool } from '../registry.js'

export const RemovePagesParams = z.object({
  /**
   * Required, unlike the tools that turn or crop pages where blank means "all".
   * Blank here would mean deleting the document.
   */
  pages: z.string().trim().min(1, { message: 'name the pages to remove' }).max(400),
})

export type RemovePagesParams = z.infer<typeof RemovePagesParams>

export const removePages: Tool<RemovePagesParams> = {
  id: 'remove-pages',
  title: 'Remove pages',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: RemovePagesParams,
  ui: {
    group: 'organise',
    icon: 'scissors',
    surface: 'canvas',
    pdfView: 'pages',
    preview: 'none',
    blurb:
      'Take pages out of a document. Click the ones to remove, or name them — what is left keeps its order and everything else about it.',
    fields: [
      {
        name: 'pages',
        label: 'Pages to remove',
        kind: 'text',
        help: 'For example 2-3,6 — click the pages above to choose them.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const doc = await loadPdf(input.path)
      const count = doc.getPageCount()
      const doomed = new Set(parsePageRanges(params.pages, count))

      if (doomed.size >= count) {
        throw new BadInputError(
          `that would remove every page of ${input.name}, leaving nothing to hand back`,
        )
      }

      /**
       * Removed from the back forwards: taking page 2 out of a document
       * renumbers everything after it, so working upwards would delete the
       * wrong pages from the second one on.
       */
      for (const page of [...doomed].sort((a, b) => b - a)) {
        doc.removePage(page - 1)
      }

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await doc.save())
      outputs.push({
        path: dest,
        name,
        mime: PDF_MIME,
        bytes: (await stat(dest)).size,
        meta: { removed: doomed.size, kept: count - doomed.size },
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
