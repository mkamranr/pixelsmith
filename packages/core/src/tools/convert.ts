import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { EXT_BY_FORMAT, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { deriveName, uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/** Formats that can carry an alpha channel. JPEG cannot. */
const SUPPORTS_ALPHA = new Set(['png', 'webp', 'avif', 'tiff'])
/** Formats that can hold more than one frame. */
const SUPPORTS_ANIMATION = new Set(['webp', 'gif'])

export const ConvertParams = z.object({
  to: z.enum(['jpeg', 'png', 'webp', 'avif', 'tiff']).default('jpeg'),
  quality: z.number().int().min(1).max(100).default(85),
  /** Colour placed behind transparency when the target cannot keep it. */
  background: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
})

export type ConvertParams = z.infer<typeof ConvertParams>

export const convert: Tool<ConvertParams> = {
  id: 'convert',
  title: 'Convert format',
  queue: 'image',
  // SVG is accepted here and nowhere else: this is the tool whose job is to
  // turn something that is not pixels into pixels.
  accepts: [...RASTER_MIMES, 'image/svg+xml'],
  params: ConvertParams,
  ui: {
    group: 'convert',
    icon: 'file-image',
    preview: 'format',
    surface: 'canvas',
    blurb: 'Move images between JPEG, PNG, WebP, AVIF and TIFF — including HEIC and SVG inputs.',
    fields: [
      {
        name: 'to',
        label: 'Convert to',
        kind: 'select',
        default: 'jpeg',
        options: [
          { value: 'jpeg', label: 'JPEG — widest compatibility' },
          { value: 'png', label: 'PNG — lossless, keeps transparency' },
          { value: 'webp', label: 'WebP — small, keeps transparency' },
          { value: 'avif', label: 'AVIF — smallest' },
          { value: 'tiff', label: 'TIFF — archival' },
        ],
      },
      { name: 'quality', label: 'Quality', kind: 'number', min: 1, max: 100, default: 85 },
      {
        name: 'background',
        label: 'Background',
        kind: 'color',
        default: '#ffffff',
        help: 'Used where transparency cannot be kept, as in JPEG.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []
    const target = params.to

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const sourceAnimated = (probe.pages ?? 1) > 1
      // Only read every frame when the destination can actually store them;
      // otherwise we would write a tall strip of stacked frames.
      const animated = sourceAnimated && SUPPORTS_ANIMATION.has(target)

      let img = openImage(input.path, { animated })
      if (!SUPPORTS_ALPHA.has(target)) {
        img = img.flatten({ background: params.background })
      }

      const name = uniqueName(taken, deriveName(input.name, { ext: EXT_BY_FORMAT[target] }))
      const dest = join(outDir, name)

      switch (target) {
        case 'jpeg':
          await img.jpeg({ quality: params.quality, mozjpeg: true }).toFile(dest)
          break
        case 'png':
          await img.png({ compressionLevel: 9 }).toFile(dest)
          break
        case 'webp':
          await img.webp({ quality: params.quality }).toFile(dest)
          break
        case 'avif':
          await img.avif({ quality: params.quality }).toFile(dest)
          break
        case 'tiff':
          await img.tiff({ quality: params.quality, compression: 'deflate' }).toFile(dest)
          break
      }

      outputs.push({ path: dest, name, mime: MIME_BY_FORMAT[target]!, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
