import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { runQpdfWithSecrets } from '../qpdf.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const PdfProtectParams = z.object({
  /**
   * Twelve characters minimum. A four-digit PDF password is decorative: the
   * encryption is only as strong as what it is derived from.
   */
  password: z.string().min(12).max(200),
  allowPrinting: z.boolean().default(true),
  allowCopying: z.boolean().default(false),
})

export type PdfProtectParams = z.infer<typeof PdfProtectParams>

export const pdfProtect: Tool<PdfProtectParams> = {
  id: 'pdf-protect',
  title: 'Protect PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: PdfProtectParams,
  ui: {
    group: 'pdf-secure',
    icon: 'lock',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Lock a document with a password, and choose whether it can be printed or copied.',
    fields: [
      { name: 'password', label: 'Password', kind: 'text',
        help: 'At least 12 characters. There is no way to recover it — keep a copy.' },
      { name: 'allowPrinting', label: 'Allow printing', kind: 'toggle', default: true },
      { name: 'allowCopying', label: 'Allow copying text', kind: 'toggle', default: false },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)

      // AES-256, which is the only PDF encryption worth using; the older
      // 40- and 128-bit RC4 schemes are broken.
      //
      // The user password, owner password and key length are positional:
      // `--encrypt user owner key-length [options] --`. The named spellings
      // (`--user-password=`, `--bits=`) only arrived in qpdf 11.7, and the
      // image this ships on carries 11.3, which exits 2 on them. Every qpdf
      // accepts the positional form, so it is the one that travels.
      await runQpdfWithSecrets(settings, [
        '--encrypt',
        params.password,
        params.password,
        '256',
        `--print=${params.allowPrinting ? 'full' : 'none'}`,
        `--extract=${params.allowCopying ? 'y' : 'n'}`,
        '--',
        input.path,
        dest,
      ])

      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
