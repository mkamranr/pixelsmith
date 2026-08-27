import { createRegistry } from '../registry.js'
import { blurFaces } from './blur-faces.js'
import { compress } from './compress.js'
import { convert } from './convert.js'
import { crop } from './crop.js'
import { editor } from './editor.js'
import { htmlShot } from './htmlshot.js'
import { mergePdf } from './pdf-merge.js'
import { organizePdf } from './pdf-organize.js'
import { rotatePdf } from './pdf-rotate.js'
import { pdfCrop } from './pdf-crop.js'
import { imagesToPdf } from './pdf-from-images.js'
import { pdfPageNumbers } from './pdf-page-numbers.js'
import { pdfToImage } from './pdf-to-image.js'
import { pdfWatermark } from './pdf-watermark.js'
import { splitPdf } from './pdf-split.js'
import { meme } from './meme.js'
import { removeBackground } from './remove-background.js'
import { resize } from './resize.js'
import { rotate } from './rotate.js'
import { upscale } from './upscale.js'
import { watermark } from './watermark.js'

/**
 * Every tool Pixelsmith can run. Adding a module to this list is the only
 * wiring a new tool needs: routes, forms, API docs and validation all read from
 * the registry.
 */
export const ALL_TOOLS = [
  compress,
  resize,
  crop,
  rotate,
  editor,
  convert,
  upscale,
  removeBackground,
  watermark,
  blurFaces,
  meme,
  htmlShot,
  // ---- PDF ----
  mergePdf,
  splitPdf,
  organizePdf,
  rotatePdf,
  pdfToImage,
  imagesToPdf,
  pdfPageNumbers,
  pdfWatermark,
  pdfCrop,
]

export const registry = createRegistry(ALL_TOOLS)

export {
  imagesToPdf,
  mergePdf,
  pdfCrop,
  pdfPageNumbers,
  pdfToImage,
  pdfWatermark,
  organizePdf,
  rotatePdf,
  splitPdf,
  blurFaces,
  editor,
  compress,
  convert,
  crop,
  htmlShot,
  meme,
  removeBackground,
  resize,
  rotate,
  upscale,
  watermark,
}
