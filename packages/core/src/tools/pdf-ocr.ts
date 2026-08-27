import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { runExternal } from '../external.js'
import { ExternalToolFailedError } from '../errors.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { renderPdfPages } from '../pdf-render.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/**
 * The languages whose traineddata is installed in the runner image. Offering
 * more would hand the user a tesseract error about a missing tessdata file,
 * which is not their problem to decode.
 */
export const OCR_LANGUAGES = ['eng', 'ara', 'eng+ara'] as const

/** Recognition is slow, but not unbounded: one page does not get forever. */
const OCR_TIMEOUT_MS = 120_000

export const OcrPdfParams = z.object({
  language: z.enum(OCR_LANGUAGES).default('eng'),
  /**
   * 300 is the resolution tesseract is tuned for. Below about 200 accuracy
   * falls off sharply; above 400 it mostly costs time.
   */
  dpi: z.coerce.number().int().min(150).max(600).default(300),
})

export type OcrPdfParams = z.infer<typeof OcrPdfParams>

export const ocrPdf: Tool<OcrPdfParams> = {
  id: 'ocr-pdf',
  title: 'OCR PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: OcrPdfParams,
  ui: {
    group: 'pdf-convert',
    icon: 'scan-text',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Make a scan searchable. Each page is recognised and gets a text layer behind the image, so the words can be found and copied.',
    fields: [
      { name: 'language', label: 'Language', kind: 'select', default: 'eng',
        options: [
          { value: 'eng', label: 'English' },
          { value: 'ara', label: 'Arabic' },
          { value: 'eng+ara', label: 'English and Arabic' },
        ],
        help: 'Choosing both is slower, and worth it only for a mixed document.' },
      { name: 'dpi', label: 'Recognition detail (dpi)', kind: 'number', min: 150, max: 600, default: 300,
        help: '300 suits most scans. Higher costs time without adding much accuracy.' },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const input of inputs) {
      const pageCount = (await loadPdf(input.path)).getPageCount()
      const work = await mkdtemp(join(tmpdir(), 'pixelsmith-ocr-'))

      try {
        const recognised = await PDFDocument.create()

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
          // One page at a time. Re-parsing the document per page costs little
          // beside recognition itself, and holding every rendered page of a
          // long scan in memory at once does not end well.
          const [png] = await renderPdfPages(input.path, [pageNumber], { dpi: params.dpi })
          const image = join(work, `page-${pageNumber}.png`)
          await writeFile(image, png!)

          /**
           * `tesseract <image> <outputbase> [options] <configfile>` — the
           * trailing `pdf` is a configfile, not a flag, and it has to come
           * last: tesseract reads anything after a configfile as a further
           * configfile. Its PDF output is the page image with an invisible
           * text layer positioned by tesseract itself, which is why the
           * coordinate mapping is not ours to get wrong.
           */
          const base = join(work, `page-${pageNumber}-ocr`)
          await runExternal(
            'Tesseract',
            settings.tesseractPath ?? 'tesseract',
            [image, base, '-l', params.language, '--dpi', String(params.dpi), 'pdf'],
            { timeoutMs: OCR_TIMEOUT_MS },
          )

          // Tesseract exits 0 on some unreadable pages having written nothing.
          // A finished job with a missing page is worse than a clear failure.
          const produced = await readFile(`${base}.pdf`).catch(() => undefined)
          if (!produced) {
            throw new ExternalToolFailedError(
              'Tesseract',
              `it reported success but produced no text layer for page ${pageNumber}, which usually means the page could not be read as an image`,
            )
          }

          const [page] = await recognised.copyPages(await PDFDocument.load(produced), [0])
          recognised.addPage(page!)
          onProgress?.(pageNumber / pageCount)
        }

        const name = uniqueName(taken, input.name)
        const dest = join(outDir, name)
        await writeFile(dest, await recognised.save())
        outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }

    return outputs
  },
}
