import sharp from 'sharp'
import { renderPdfPage } from '../../src/pdf-render.js'

/**
 * Render a PDF page and measure how much ink sits in a region, given as
 * fractions of the page. Lets a test assert that a watermark or a page number
 * actually landed where it was meant to, instead of only that the file grew.
 *
 * Returns the standard deviation: a blank area is 0, and anything drawn on it
 * raises the figure.
 */
export async function inkInRegion(
  pdfPath: string,
  page: number,
  region: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const png = await renderPdfPage(pdfPath, page, { scale: 2 })
  const meta = await sharp(png).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  const crop = {
    left: Math.max(0, Math.round(region.x * width)),
    top: Math.max(0, Math.round(region.y * height)),
    width: Math.max(1, Math.min(width, Math.round(region.width * width))),
    height: Math.max(1, Math.min(height, Math.round(region.height * height))),
  }
  crop.width = Math.min(crop.width, width - crop.left)
  crop.height = Math.min(crop.height, height - crop.top)

  const strip = await sharp(png).extract(crop).toBuffer()
  return (await sharp(strip).stats()).channels[0]!.stdev
}

/** Mean luminance of a whole rendered page. */
export async function pageLuminance(pdfPath: string, page: number): Promise<number> {
  const png = await renderPdfPage(pdfPath, page, { scale: 1.5 })
  return (await sharp(png).stats()).channels[0]!.mean
}
