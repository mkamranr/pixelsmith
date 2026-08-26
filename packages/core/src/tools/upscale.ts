import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { LimitExceededError } from '../errors.js'
import { callInference } from '../inference.js'
import { deriveName, uniqueName } from '../naming.js'
import { MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import type { Tool } from '../registry.js'

/**
 * Ceiling on the *result*. Upscaling multiplies pixels by the square of the
 * factor, so a modest input becomes an enormous output: 4x of a 20-megapixel
 * photo is 320 megapixels, which would exhaust the worker. Refuse up front with
 * a number the user can understand rather than dying mid-job.
 */
const MAX_OUTPUT_PIXELS = 120_000_000

export const UpscaleParams = z.object({
  /**
   * Only the factors we ship weights for. Coerced, because this is presented as
   * a dropdown and a browser submits "2" as a string — a plain literal union
   * would reject every real form post while passing every unit test.
   */
  scale: z.coerce
    .number()
    .int()
    .refine((v) => v === 2 || v === 4, { message: 'only 2x and 4x are available' })
    .default(2),
  model: z.enum(['fsrcnn']).default('fsrcnn'),
})

export type UpscaleParams = z.infer<typeof UpscaleParams>

export const upscale: Tool<UpscaleParams> = {
  id: 'upscale',
  title: 'Upscale image',
  queue: 'ml',
  accepts: [...RASTER_MIMES],
  params: UpscaleParams,
  ui: {
    group: 'modify',
    icon: 'maximize',
    preview: 'dimensions',
    surface: 'canvas',
    blurb: 'Enlarge an image with a neural network instead of a blur — recovers detail plain scaling cannot.',
    fields: [
      {
        name: 'scale',
        label: 'Enlarge by',
        kind: 'select',
        default: '2',
        options: [
          { value: '2', label: '2x' },
          { value: '4', label: '4x' },
        ],
      },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const resultPixels = (probe.width ?? 0) * (probe.height ?? 0) * params.scale * params.scale
      if (resultPixels > MAX_OUTPUT_PIXELS) {
        throw new LimitExceededError(
          'upscale result',
          `${probe.width}x${probe.height} at ${params.scale}x would be ${Math.round(resultPixels / 1e6)} megapixels, ` +
            `which exceeds the ${MAX_OUTPUT_PIXELS / 1e6} megapixel limit`,
        )
      }

      const ext = extname(input.name).replace('.', '').toLowerCase() || 'png'
      const name = uniqueName(taken, deriveName(input.name, { ext }))
      const dest = join(outDir, name)

      await callInference(settings, '/upscale', {
        in_path: input.path,
        out_path: dest,
        scale: params.scale,
        model: params.model,
      })

      outputs.push({
        path: dest,
        name,
        mime: MIME_BY_FORMAT[ext === 'jpg' ? 'jpeg' : ext] ?? 'image/png',
        bytes: (await stat(dest)).size,
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
