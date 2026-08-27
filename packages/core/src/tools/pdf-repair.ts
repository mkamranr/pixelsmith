import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { runQpdf } from '../qpdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const PdfRepairParams = z.object({})

export type PdfRepairParams = z.infer<typeof PdfRepairParams>

export const pdfRepair: Tool<PdfRepairParams> = {
  id: 'pdf-repair',
  title: 'Repair PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  /**
   * The probe's job is to refuse damaged documents. This tool exists to mend
   * them, so it has to see the damage rather than be protected from it.
   */
  skipProbe: true,
  params: PdfRepairParams,
  ui: {
    group: 'pdf-optimize',
    icon: 'merge',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Rebuild a damaged document, recovering whatever is still readable.',
    fields: [],
  },

  async run({ inputs, outDir, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)

      // Reading and rewriting the file rebuilds the cross-reference table and
      // discards unreachable objects, which is what "repair" amounts to.
      await runQpdf(settings, [input.path, dest])

      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
