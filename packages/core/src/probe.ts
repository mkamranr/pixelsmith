import { readFile, stat } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { fileTypeFromFile } from 'file-type'
import sharp from 'sharp'
import { LimitExceededError, MalformedImageError, UnsupportedInputError } from './errors.js'
import { assertSvgSafe } from './svg.js'

/**
 * Guard rails applied to every input before it reaches a decoder. Image
 * decoders are a classic attack surface: a few hundred bytes of crafted PNG can
 * ask for gigabytes of RAM. These limits are the cheap, boring defence.
 */
export interface ProbeLimits {
  maxBytes: number
  /** Per-frame pixel count (width x height). */
  maxPixels: number
  /** Longest single side. */
  maxDimension: number
  /** Frames in an animation. */
  maxPages: number
}

export const DEFAULT_LIMITS: ProbeLimits = {
  maxBytes: 200 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxDimension: 40_000,
  maxPages: 600,
}

export interface ImageProbe {
  mime: string
  /** libvips format name, e.g. `jpeg`. */
  format: string
  width: number
  height: number
  /** 1 for stills, frame count for animations. */
  pages: number
  bytes: number
  hasAlpha: boolean
}

/** Input types we are willing to hand to a decoder, mapped to libvips loaders. */
const SUPPORTED: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/avif': 'heif',
  'image/heic': 'heif',
  'image/heif': 'heif',
  'image/bmp': 'magick',
  'image/x-icon': 'magick',
  'image/vnd.adobe.photoshop': 'magick',
  'image/svg+xml': 'svg',
}

/**
 * Formats whose byte stream must end with a known marker. Truncated uploads
 * pass a metadata check (the header is intact) and only blow up later inside a
 * worker, so we catch them here instead.
 */
const TAIL_MARKERS: Record<string, (tail: Buffer) => boolean> = {
  'image/png': (t) => t.includes(Buffer.from('IEND')),
  'image/jpeg': (t) => t.includes(Buffer.from([0xff, 0xd9])),
  'image/gif': (t) => t.includes(Buffer.from([0x3b])),
}

/**
 * Identify a file by its bytes. Exported because the run gate has to know which
 * validator applies — an image and a PDF need entirely different checks.
 */
export async function sniffMime(path: string): Promise<string> {
  const detected = await fileTypeFromFile(path)
  if (detected) return detected.mime === 'application/xml' ? 'image/svg+xml' : detected.mime

  // SVG is text, so it has no magic number for file-type to match.
  const head = (await readFile(path)).subarray(0, 4096).toString('utf8')
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml'

  throw new UnsupportedInputError('upload', 'unknown')
}

async function readTail(path: string, n: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const len = Math.min(n, size)
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, size - len)
    return buf
  } finally {
    await handle.close()
  }
}

/**
 * Identify a file by its bytes and confirm it is safe to decode.
 * Order matters: cheap checks first, so a hostile file is rejected before it
 * costs us any real work.
 */
export async function probeImage(path: string, limits: ProbeLimits = DEFAULT_LIMITS): Promise<ImageProbe> {
  const { size } = await stat(path)
  if (size === 0) throw new MalformedImageError('file is empty')
  if (size > limits.maxBytes) {
    throw new LimitExceededError('maxBytes', `${size} bytes exceeds ${limits.maxBytes}`)
  }

  const mime = await sniffMime(path)
  if (!(mime in SUPPORTED)) throw new UnsupportedInputError('upload', mime)

  // SVG is vetted before librsvg is handed the file: a DOCTYPE entity or an
  // external reference must never reach a parser, even one that will reject it.
  if (mime === 'image/svg+xml') {
    assertSvgSafe(await readFile(path, 'utf8'))
  }

  const marker = TAIL_MARKERS[mime]
  if (marker && !marker(await readTail(path, 64))) {
    throw new MalformedImageError(`${mime} stream is truncated`)
  }

  let meta: sharp.Metadata
  try {
    // limitInputPixels is disabled here only so we can report a precise
    // limit error below rather than libvips' generic one.
    meta = await sharp(path, { limitInputPixels: false, unlimited: false }).metadata()
  } catch (err) {
    throw new MalformedImageError(err instanceof Error ? err.message.split('\n')[0]! : 'decode failed')
  }

  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const pages = meta.pages ?? 1
  if (width <= 0 || height <= 0) throw new MalformedImageError('image reports no dimensions')

  if (Math.max(width, height) > limits.maxDimension) {
    throw new LimitExceededError('maxDimension', `${width}x${height} exceeds ${limits.maxDimension}px per side`)
  }
  if (width * height > limits.maxPixels) {
    throw new LimitExceededError('maxPixels', `${width * height} pixels exceeds ${limits.maxPixels}`)
  }
  if (pages > limits.maxPages) {
    throw new LimitExceededError('maxPages', `${pages} frames exceeds ${limits.maxPages}`)
  }

  return {
    mime,
    format: meta.format ?? SUPPORTED[mime]!,
    width,
    height,
    pages,
    bytes: size,
    hasAlpha: meta.hasAlpha ?? false,
  }
}
