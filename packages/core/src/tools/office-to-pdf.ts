import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { convertWithLibreOffice } from '../soffice.js'
import { deriveName, uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/**
 * Types LibreOffice can open, as detected from the file's bytes.
 *
 * The legacy formats all report as `application/x-cfb`: Word 97, Excel 97 and
 * PowerPoint 97 share one container and cannot be told apart by magic bytes.
 * They are accepted as a group and LibreOffice decides what it can actually
 * read, which is the only honest arrangement.
 */
export const OFFICE_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/x-cfb',
  'application/rtf',
  'text/rtf',
] as const

export const OfficeToPdfParams = z.object({})

export type OfficeToPdfParams = z.infer<typeof OfficeToPdfParams>

export const officeToPdf: Tool<OfficeToPdfParams> = {
  id: 'office-to-pdf',
  title: 'Office to PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [...OFFICE_MIMES],
  // Neither the image nor the PDF probe applies to a Word document; the type
  // and size are still checked from the bytes.
  skipProbe: true,
  params: OfficeToPdfParams,
  ui: {
    group: 'pdf-convert',
    icon: 'file-image',
    surface: 'canvas',
    preview: 'none',
    blurb: 'Convert Word, Excel, PowerPoint and OpenDocument files into PDF.',
    fields: [],
  },

  async run({ inputs, outDir, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf' }))
      const dest = join(outDir, name)

      await convertWithLibreOffice(settings, input.path, dest, { target: 'pdf', extension: 'pdf' })

      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
