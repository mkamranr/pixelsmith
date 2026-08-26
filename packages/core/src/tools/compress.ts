import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { EXT_BY_FORMAT, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { deriveName, uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

/** Quality per preset. Chosen to look unchanged at a glance, not to hit a number. */
const LEVELS = { light: 88, balanced: 75, strong: 58 } as const

/** Bounds for the target-size search. Below this, artefacts are obvious. */
const MIN_QUALITY = 20
const MAX_QUALITY = 95
const MAX_SEARCH_STEPS = 6

export const CompressParams = z.object({
  level: z.enum(['light', 'balanced', 'strong']).default('balanced'),
  /** Aim for a file this size. Overrides `level` when set. */
  targetKb: z.number().int().positive().max(100_000).optional(),
  format: z.enum(['keep', 'jpeg', 'webp', 'avif', 'png']).default('keep'),
})

export type CompressParams = z.infer<typeof CompressParams>

/** Encode once at a given quality. Kept separate so the size search can reuse it. */
async function encodeAt(path: string, format: string, quality: number, animated: boolean): Promise<Buffer> {
  const img = openImage(path, { animated })
  switch (format) {
    case 'jpeg':
      return img.jpeg({ quality, mozjpeg: true }).toBuffer()
    case 'webp':
      return img.webp({ quality }).toBuffer()
    case 'avif':
      return img.avif({ quality }).toBuffer()
    case 'png':
      // PNG is lossless, so "quality" drives palette quantisation instead.
      return img.png({ compressionLevel: 9, palette: true, quality }).toBuffer()
    default:
      return img.toBuffer()
  }
}

/**
 * Find the highest quality whose encode fits the target.
 *
 * A binary search over quality, capped at six encodes: each one costs real CPU,
 * and the difference between the true optimum and one step away is invisible.
 * If even the floor overshoots, the floor is returned — better a slightly large
 * file than a destroyed one.
 */
async function searchForTarget(
  path: string,
  format: string,
  targetBytes: number,
  animated: boolean,
): Promise<Buffer> {
  let lo = MIN_QUALITY
  let hi = MAX_QUALITY
  let best: Buffer | null = null

  for (let step = 0; step < MAX_SEARCH_STEPS && lo <= hi; step++) {
    const mid = Math.round((lo + hi) / 2)
    const buf = await encodeAt(path, format, mid, animated)
    if (buf.length <= targetBytes) {
      best = buf
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best ?? (await encodeAt(path, format, MIN_QUALITY, animated))
}

export const compress: Tool<CompressParams> = {
  id: 'compress',
  title: 'Compress images',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: CompressParams,
  ui: {
    group: 'optimize',
    icon: 'archive',
    preview: 'format',
    surface: 'canvas',
    blurb: 'Shrink file size while keeping the picture looking the same.',
    fields: [
      {
        name: 'level',
        label: 'Compression',
        kind: 'select',
        default: 'balanced',
        options: [
          { value: 'light', label: 'Light — barely touched' },
          { value: 'balanced', label: 'Balanced — recommended' },
          { value: 'strong', label: 'Strong — smallest file' },
        ],
      },
      {
        name: 'format',
        label: 'Output format',
        kind: 'select',
        default: 'keep',
        options: [
          { value: 'keep', label: 'Keep original' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP — usually smallest' },
          { value: 'avif', label: 'AVIF — smallest, slower' },
          { value: 'png', label: 'PNG' },
        ],
      },
      {
        name: 'targetKb',
        label: 'Target size (KB)',
        kind: 'number',
        min: 1,
        help: 'Optional. When set, quality is chosen automatically to fit.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const animated = (probe.pages ?? 1) > 1
      const format = params.format === 'keep' ? (probe.format ?? 'jpeg') : params.format

      const data = params.targetKb
        ? await searchForTarget(input.path, format, params.targetKb * 1024, animated)
        : await encodeAt(input.path, format, LEVELS[params.level], animated)

      const name = uniqueName(taken, deriveName(input.name, { ext: EXT_BY_FORMAT[format] ?? 'jpg' }))
      const dest = join(outDir, name)
      await writeFile(dest, data)

      outputs.push({
        path: dest,
        name,
        mime: MIME_BY_FORMAT[format] ?? 'application/octet-stream',
        bytes: (await stat(dest)).size,
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
