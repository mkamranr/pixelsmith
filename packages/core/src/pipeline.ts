import sharp from 'sharp'

/** Raster inputs every geometry tool can handle. SVG is opt-in per tool. */
export const RASTER_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/bmp',
] as const

export const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heif: 'image/heif',
  svg: 'image/svg+xml',
}

export const EXT_BY_FORMAT: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  tiff: 'tiff',
  avif: 'avif',
  heif: 'heic',
}

export interface OpenOptions {
  /** Read every frame of an animation rather than just the first. */
  animated?: boolean
  /** Hard ceiling passed to libvips as a second line of defence after probe. */
  maxPixels?: number
}

/**
 * The single place an input image is opened.
 *
 * Two behaviours are deliberate and apply everywhere:
 * - EXIF orientation is baked into the pixels, so downstream code can treat
 *   width/height as what the viewer actually sees.
 * - Metadata is NOT copied forward. sharp drops it unless asked, and we never
 *   ask: GPS coordinates and camera serials in a shared file are a privacy leak,
 *   not a feature.
 */
export function openImage(path: string, opts: OpenOptions = {}): sharp.Sharp {
  const img = sharp(path, {
    animated: opts.animated ?? false,
    limitInputPixels: opts.maxPixels ?? 100_000_000,
    failOn: 'error',
  })
  // Orientation is meaningless for a frame strip, and applying it would rotate
  // the whole roll rather than each frame.
  return opts.animated ? img : img.autoOrient()
}

/**
 * Apply an encoder with defaults tuned for "looks the same, weighs less".
 * Tools that expose quality controls pass their own options through.
 */
export function encodeAs(img: sharp.Sharp, format: string, opts: Record<string, unknown> = {}): sharp.Sharp {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return img.jpeg({ quality: 90, mozjpeg: true, ...opts })
    case 'png':
      return img.png({ compressionLevel: 9, ...opts })
    case 'webp':
      return img.webp({ quality: 85, ...opts })
    case 'gif':
      return img.gif({ ...opts })
    case 'tiff':
      return img.tiff({ compression: 'deflate', ...opts })
    case 'avif':
      return img.avif({ quality: 55, ...opts })
    case 'heif':
      return img.heif({ quality: 70, compression: 'av1', ...opts })
    default:
      // Unknown target: let libvips pick from the extension at write time.
      return img
  }
}
