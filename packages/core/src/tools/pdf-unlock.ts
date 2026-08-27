import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { runQpdfWithSecrets } from '../qpdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const PdfUnlockParams = z.object({
  /** The document's existing password. Not a new one. */
  password: z.string().min(1).max(200),
})

export type PdfUnlockParams = z.infer<typeof PdfUnlockParams>

export const pdfUnlock: Tool<PdfUnlockParams> = {
  id: 'pdf-unlock',
  title: 'Unlock PDF',
  family: 'pdf',
  queue: 'image',
  // Deliberately does not go through the PDF probe's encryption check: an
  // encrypted document is exactly what this tool is for.
  accepts: [PDF_MIME],
  skipProbe: true,
  params: PdfUnlockParams,
  ui: {
    group: 'pdf-secure',
    icon: 'eye-off',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Remove the password from a document you can already open.',
    fields: [
      { name: 'password', label: 'Current password', kind: 'text',
        help: 'The password the document opens with today.' },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)

      await runQpdfWithSecrets(settings, [
        `--password=${params.password}`,
        '--decrypt',
        input.path,
        dest,
      ])

      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
