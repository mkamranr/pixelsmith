import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { parsePageRanges, toIndices } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const OrganizePdfParams = z.object({
  /**
   * Required, not optional. The page list *is* the instruction: pages left out
   * are removed and the order given is the new order. Defaulting it to "all"
   * would make the tool silently do nothing.
   */
  pages: z.string().trim().min(1).max(400),
})

export type OrganizePdfParams = z.infer<typeof OrganizePdfParams>

export const organizePdf: Tool<OrganizePdfParams> = {
  id: 'organize-pdf',
  title: 'Organise PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: OrganizePdfParams,
  ui: {
    group: 'organise',
    icon: 'sliders',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Reorder, remove or duplicate pages by listing the order you want.',
    fields: [
      {
        name: 'pages',
        label: 'Page order',
        kind: 'text',
        help: 'For example 3,1,2 to reorder, 1,5 to keep only those, or 1,1,2 to duplicate page one.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const selected = parsePageRanges(params.pages, source.getPageCount())

      const organised = await PDFDocument.create()
      // copyPages preserves the requested order, including repeats.
      const copied = await organised.copyPages(source, toIndices(selected))
      for (const page of copied) organised.addPage(page)

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await organised.save())
      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
