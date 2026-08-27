import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import { LimitExceededError } from '../errors.js'
import type { Tool } from '../registry.js'

export const CropParams = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive().max(40_000),
  height: z.number().int().positive().max(40_000),
})

export type CropParams = z.infer<typeof CropParams>

export const crop: Tool<CropParams> = {
  id: 'crop',
  title: 'Crop images',
  family: 'image',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: CropParams,
  ui: {
    group: 'modify',
    icon: 'crop',
    preview: 'crop',
    surface: 'crop',
    blurb: 'Cut a rectangle out of an image, or out of a whole batch at once.',
    fields: [
      { name: 'x', label: 'Left (px)', kind: 'number', min: 0, default: 0 },
      { name: 'y', label: 'Top (px)', kind: 'number', min: 0, default: 0 },
      { name: 'width', label: 'Width (px)', kind: 'number', min: 1 },
      { name: 'height', label: 'Height (px)', kind: 'number', min: 1 },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const animated = (probe.pages ?? 1) > 1
      const width = probe.width ?? 0
      const height = (animated ? probe.pageHeight : probe.height) ?? 0

      // Refuse rather than silently clamp: a crop that quietly returns a
      // different region than asked for is worse than an error saying why.
      if (params.x + params.width > width || params.y + params.height > height) {
        throw new LimitExceededError(
          'crop bounds',
          `${params.width}x${params.height} at (${params.x},${params.y}) does not fit inside ${width}x${height} for ${input.name}`,
        )
      }

      const format = probe.format ?? 'png'
      const img = openImage(input.path, { animated }).extract({
        left: params.x,
        top: params.y,
        width: params.width,
        height: params.height,
      })

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await encodeAs(img, format).toFile(dest)

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
