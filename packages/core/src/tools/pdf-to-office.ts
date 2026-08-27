import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PDF_MIME } from '../pdf.js'
import { convertWithLibreOffice } from '../soffice.js'
import { deriveName, uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const OOXML_MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const

export const PdfToOfficeParams = z.object({})

export type PdfToOfficeParams = z.infer<typeof PdfToOfficeParams>

/**
 * Both conversions are the same work through a different LibreOffice import
 * filter, so they are the same tool with a different target.
 */
function pdfToOffice(spec: {
  id: string
  title: string
  icon: string
  extension: 'docx' | 'pptx'
  infilter: string
  blurb: string
}): Tool<PdfToOfficeParams> {
  return {
    id: spec.id,
    title: spec.title,
    family: 'pdf',
    queue: 'image',
    accepts: [PDF_MIME],
    params: PdfToOfficeParams,
    ui: {
      group: 'pdf-convert',
      icon: spec.icon,
      surface: 'canvas',
      preview: 'none',
      blurb: spec.blurb,
      fields: [],
    },

    async run({ inputs, outDir, settings, onProgress }) {
      const taken = new Set<string>()
      const outputs = []

      for (const [index, input] of inputs.entries()) {
        const name = uniqueName(taken, deriveName(input.name, { ext: spec.extension }))
        const dest = join(outDir, name)

        await convertWithLibreOffice(settings, input.path, dest, {
          target: spec.extension,
          extension: spec.extension,
          infilter: spec.infilter,
        })

        outputs.push({
          path: dest,
          name,
          mime: OOXML_MIMES[spec.extension],
          bytes: (await stat(dest)).size,
        })
        onProgress?.((index + 1) / inputs.length)
      }

      return outputs
    },
  }
}

export const pdfToWord = pdfToOffice({
  id: 'pdf-to-word',
  title: 'PDF to Word',
  icon: 'file-text',
  extension: 'docx',
  infilter: 'writer_pdf_import',
  // Said plainly, because the alternative is a user wondering what went wrong.
  blurb:
    'Turn a PDF into an editable Word document. The text stays real text, but it arrives in text boxes rather than flowing paragraphs — a PDF records where the words sit, not how they were laid out.',
})

export const pdfToPowerpoint = pdfToOffice({
  id: 'pdf-to-powerpoint',
  title: 'PDF to PowerPoint',
  icon: 'presentation',
  extension: 'pptx',
  infilter: 'impress_pdf_import',
  blurb: 'Turn each page of a PDF into an editable slide.',
})
