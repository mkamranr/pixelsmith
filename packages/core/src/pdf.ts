import { open, readFile, stat } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { EncryptedPdfError, LimitExceededError, MalformedPdfError, UnsupportedInputError } from './errors.js'

/**
 * Guard rails for PDF input, mirroring what `probeImage` does for pictures.
 * A PDF is a container format with an object graph inside it, so the cheap
 * structural checks come first and parsing comes last.
 */
export interface PdfLimits {
  maxBytes: number
  maxPages: number
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxPages: 2000,
}

export interface PdfProbe {
  mime: 'application/pdf'
  pages: number
  bytes: number
  encrypted: boolean
  /** The version in the header, e.g. `1.7`. */
  version: string
}

const HEADER = '%PDF-'

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Identify a PDF and confirm it is safe to work with.
 *
 * Encryption is detected two ways: by scanning for an /Encrypt entry, and by
 * letting pdf-lib refuse the document. Either is enough — the point is to tell
 * the user their file is locked instead of failing somewhere deep in a tool.
 */
export async function probePdf(path: string, limits: PdfLimits = DEFAULT_PDF_LIMITS): Promise<PdfProbe> {
  const { size } = await stat(path)
  if (size === 0) throw new MalformedPdfError('file is empty')
  if (size > limits.maxBytes) {
    throw new LimitExceededError('maxBytes', `${size} bytes exceeds ${limits.maxBytes}`)
  }

  const head = await readHead(path, 1024)
  const headText = head.toString('latin1')
  if (!headText.startsWith(HEADER)) {
    // Trust the bytes, not the extension.
    throw new UnsupportedInputError('upload', 'not a PDF')
  }
  const version = headText.slice(HEADER.length, HEADER.length + 3)

  const bytes = await readFile(path)
  // A cheap scan, so a locked document is named as such even when a parser
  // would have thrown something less useful.
  if (/\/Encrypt[\s\d]/.test(bytes.toString('latin1'))) {
    throw new EncryptedPdfError()
  }

  /**
   * Reading the page count is inside the guard, not after it. A truncated file
   * loads far enough for pdf-lib to accept it and then throws a bare TypeError
   * on the first real access — which must reach the user as "this PDF is
   * damaged", never as an internal error.
   */
  let pages: number
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    pages = doc.getPageCount()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse failed'
    if (/encrypt/i.test(message)) throw new EncryptedPdfError()
    throw new MalformedPdfError(message.split('\n')[0]!)
  }

  if (pages === 0) throw new MalformedPdfError('document has no pages')
  if (pages > limits.maxPages) {
    throw new LimitExceededError('maxPages', `${pages} pages exceeds ${limits.maxPages}`)
  }

  return { mime: 'application/pdf', pages, bytes: size, encrypted: false, version }
}

/**
 * Load a PDF for editing, mapping failures onto our own error types.
 *
 * The page count is touched here deliberately: it forces the lazy parse to
 * happen now, inside this guard, rather than throwing a raw TypeError later
 * inside whichever tool happened to use the document first.
 */
export async function loadPdf(path: string): Promise<PDFDocument> {
  const bytes = await readFile(path)
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    doc.getPageCount()
    return doc
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse failed'
    if (/encrypt/i.test(message)) throw new EncryptedPdfError()
    throw new MalformedPdfError(message.split('\n')[0]!)
  }
}

export const PDF_MIME = 'application/pdf'
