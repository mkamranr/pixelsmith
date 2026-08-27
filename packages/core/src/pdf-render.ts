import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { BadInputError, MalformedPdfError } from './errors.js'

/**
 * Rasterise PDF pages.
 *
 * pdf.js is used through its `legacy` build, which is the one written for a
 * server rather than a browser, with @napi-rs/canvas providing the 2D surface.
 * Both are permissively licensed and ship as prebuilt binaries, so this adds no
 * system package to the container.
 *
 * Everything is resolved from node_modules. Nothing is fetched: `isEvalSupported`
 * is off and the font data is read from disk, so a document cannot make the
 * renderer execute code or reach the network.
 */

/** 72 points per inch is the PDF unit, so scale is simply dpi / 72. */
const POINTS_PER_INCH = 72

export interface RenderOptions {
  /** Direct multiplier on the page's natural size. Overrides `dpi`. */
  scale?: number
  dpi?: number
  /** Ceiling on either dimension, so one page cannot exhaust memory. */
  maxPixels?: number
}

const require_ = createRequire(import.meta.url)

/** Where pdf.js keeps the metrics for the 14 standard PDF fonts. */
function standardFontDataUrl(): string {
  const entry = require_.resolve('pdfjs-dist/package.json')
  return `${join(dirname(entry), 'standard_fonts')}/`
}

async function openDocument(path: string) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  try {
    return await pdfjs.getDocument({
      data,
      // A PDF is untrusted input: no eval, no system font probing, no network.
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: standardFontDataUrl(),
    }).promise
  } catch (err) {
    const message = err instanceof Error ? err.message : 'could not open document'
    throw new MalformedPdfError(message.split('\n')[0]!)
  }
}

/** Render one page (1-based) to a PNG buffer. */
export async function renderPdfPage(path: string, pageNumber: number, options: RenderOptions = {}): Promise<Buffer> {
  const [png] = await renderPdfPages(path, [pageNumber], options)
  return png!
}

/** Render several pages in one pass, reusing the parsed document. */
export async function renderPdfPages(
  path: string,
  pageNumbers: number[],
  options: RenderOptions = {},
): Promise<Buffer[]> {
  const doc = await openDocument(path)

  try {
    const scale = options.scale ?? (options.dpi ? options.dpi / POINTS_PER_INCH : 1.5)
    const maxPixels = options.maxPixels ?? 8000
    const rendered: Buffer[] = []

    for (const pageNumber of pageNumbers) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
        throw new BadInputError(`page ${pageNumber} is not in this ${doc.numPages}-page document`)
      }

      const page = await doc.getPage(pageNumber)
      let viewport = page.getViewport({ scale })

      // Clamp before allocating: a large page at a high dpi is otherwise an
      // easy way to ask for a gigabyte of canvas.
      const longest = Math.max(viewport.width, viewport.height)
      if (longest > maxPixels) {
        viewport = page.getViewport({ scale: scale * (maxPixels / longest) })
      }

      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      // PDF pages are transparent where nothing is drawn; paper is white.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)

      /**
       * @napi-rs/canvas' 2D context implements the same surface pdf.js draws
       * on, but the browser's DOM type is not available in a Node build — and
       * pulling DOM types into this package would let `document` slip into
       * genuinely server-side code. So the shape is asserted here instead.
       */
      const renderTask = page.render({ canvasContext: context, viewport } as unknown as Parameters<typeof page.render>[0])
      await renderTask.promise
      rendered.push(canvas.encodeSync('png'))
      page.cleanup()
    }

    return rendered
  } finally {
    await doc.destroy()
  }
}
