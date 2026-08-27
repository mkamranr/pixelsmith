import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { parsePageRanges, toIndices } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { deriveName, uniqueName } from '../naming.js'
import type { OutputFile, Tool } from '../registry.js'

export const SplitPdfParams = z.object({
  mode: z.enum(['each', 'select']).default('each'),
  /** Which pages to keep, when extracting rather than splitting. */
  pages: z.string().trim().max(400).optional(),
})

export type SplitPdfParams = z.infer<typeof SplitPdfParams>

export const splitPdf: Tool<SplitPdfParams> = {
  id: 'split-pdf',
  title: 'Split PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: SplitPdfParams,
  ui: {
    group: 'organise',
    icon: 'split',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Separate a PDF into single pages, or pull out just the pages you need.',
    fields: [
      {
        name: 'mode',
        label: 'Split',
        kind: 'segmented',
        default: 'each',
        options: [
          { value: 'each', label: 'Every page separately' },
          { value: 'select', label: 'Extract a selection' },
        ],
      },
      {
        name: 'pages',
        label: 'Pages',
        kind: 'text',
        showWhen: { field: 'mode', equals: ['select'] },
        help: 'For example 1-3,5,8- — leave blank for every page.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs: OutputFile[] = []

    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const pageCount = source.getPageCount()

      if (params.mode === 'each') {
        for (let page = 1; page <= pageCount; page++) {
          const single = await PDFDocument.create()
          const [copied] = await single.copyPages(source, [page - 1])
          single.addPage(copied)

          const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf', suffix: `-page-${page}` }))
          const dest = join(outDir, name)
          await writeFile(dest, await single.save())
          outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
        }
      } else {
        const selected = parsePageRanges(params.pages, pageCount)
        const extracted = await PDFDocument.create()
        const copied = await extracted.copyPages(source, toIndices(selected))
        for (const page of copied) extracted.addPage(page)

        const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf', suffix: '-pages' }))
        const dest = join(outDir, name)
        await writeFile(dest, await extracted.save())
        outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      }

      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
