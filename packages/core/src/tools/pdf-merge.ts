import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { stem } from '../naming.js'
import type { Tool } from '../registry.js'

export const MergePdfParams = z.object({
  /** Name for the combined document, without an extension. */
  filename: z.string().trim().max(120).default('merged'),
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
    preview: 'none',
    blurb: 'Combine several PDFs into one document, in the order you choose.',
    fields: [{ name: 'filename', label: 'Name the result', kind: 'text', default: 'merged' }],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const merged = await PDFDocument.create()

    // Input order is the document order, which is why the upload list is
    // reorderable in the interface.
    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const pages = await merged.copyPages(source, source.getPageIndices())
      for (const page of pages) merged.addPage(page)
      onProgress?.((index + 1) / inputs.length)
    }

    const name = `${stem(params.filename || 'merged') || 'merged'}.pdf`
    const dest = join(outDir, name)
    await writeFile(dest, await merged.save())

    return [{ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size }]
  },
}
