import { createRegistry } from '../registry.js'
import { blurFaces } from './blur-faces.js'
import { compress } from './compress.js'
import { convert } from './convert.js'
import { crop } from './crop.js'
import { editor } from './editor.js'
import { htmlShot } from './htmlshot.js'
import { mergePdf } from './pdf-merge.js'
import { organizePdf } from './pdf-organize.js'
import { editPdf } from './pdf-edit.js'
import { fillForm } from './pdf-form.js'
import { scanPdf } from './pdf-scan.js'
import { pdfToMarkdown } from './pdf-to-markdown.js'
import { translatePdf } from './pdf-translate.js'
import { removePages } from './pdf-remove-pages.js'
import { rotatePdf } from './pdf-rotate.js'
import { officeToPdf } from './office-to-pdf.js'
import { pdfCompress } from './pdf-compress.js'
import { pdfProtect } from './pdf-protect.js'
import { pdfRepair } from './pdf-repair.js'
import { pdfUnlock } from './pdf-unlock.js'
import { pdfCrop } from './pdf-crop.js'
import { htmlToPdf } from './pdf-from-html.js'
import { imagesToPdf } from './pdf-from-images.js'
import { pdfPageNumbers } from './pdf-page-numbers.js'
import { ocrPdf } from './pdf-ocr.js'
import { comparePdf } from './pdf-compare.js'
import { summarisePdf } from './pdf-summarise.js'
import { redactPdf } from './pdf-redact.js'
import { signPdf } from './pdf-sign.js'
import { pdfToExcel } from './pdf-to-excel.js'
import { pdfToPowerpoint, pdfToWord } from './pdf-to-office.js'
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
  removePages,
  pdfToImage,
  pdfToMarkdown,
  imagesToPdf,
  scanPdf,
  pdfPageNumbers,
  pdfWatermark,
  pdfCrop,
  htmlToPdf,
  pdfCompress,
  pdfProtect,
  pdfUnlock,
  pdfRepair,
  officeToPdf,
  ocrPdf,
  pdfToWord,
  pdfToExcel,
  pdfToPowerpoint,
  redactPdf,
  signPdf,
  editPdf,
  fillForm,
  comparePdf,
  summarisePdf,
  translatePdf,
]

export const registry = createRegistry(ALL_TOOLS)

export {
  htmlToPdf,
  officeToPdf,
  pdfProtect,
  pdfRepair,
  pdfUnlock,
  pdfCompress,
  imagesToPdf,
  mergePdf,
  pdfCrop,
  pdfPageNumbers,
  pdfToImage,
  pdfWatermark,
  organizePdf,
  editPdf,
  fillForm,
  pdfToMarkdown,
  removePages,
  rotatePdf,
  scanPdf,
  splitPdf,
  translatePdf,
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
