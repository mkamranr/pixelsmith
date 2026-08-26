import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { callInference } from '../inference.js'
import { deriveName, uniqueName } from '../naming.js'
import { MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import type { Tool } from '../registry.js'

export const RemoveBackgroundParams = z.object({
  model: z.enum(['u2net', 'u2netp']).default('u2net'),
  /** Blank keeps transparency; a colour composites the subject onto it. */
  background: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  feather: z.coerce.number().int().min(0).max(20).default(2),
})

export type RemoveBackgroundParams = z.infer<typeof RemoveBackgroundParams>

export const removeBackground: Tool<RemoveBackgroundParams> = {
  id: 'remove-background',
  title: 'Remove background',
  queue: 'ml',
  accepts: [...RASTER_MIMES],
  params: RemoveBackgroundParams,
  ui: {
    group: 'modify',
    icon: 'scissors',
    preview: 'none',
    surface: 'canvas',
    blurb: 'Cut the subject out of a photo and drop the background — on this machine, with a bundled model.',
    fields: [
      {
        name: 'model',
        label: 'Model',
        kind: 'select',
        default: 'u2net',
        options: [
          { value: 'u2net', label: 'Accurate (slower)' },
          { value: 'u2netp', label: 'Fast (lighter)' },
        ],
      },
      {
        name: 'background',
        label: 'Replace background with',
        kind: 'color',
        help: 'Leave unset to get a transparent PNG.',
      },
      { name: 'feather', label: 'Edge softness (px)', kind: 'number', min: 0, max: 20, default: 2 },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      // Transparency needs a format that can carry it, whatever came in.
      const keepAlpha = !params.background
      const ext = keepAlpha ? 'png' : (extname(input.name).replace('.', '').toLowerCase() || 'png')
      const name = uniqueName(taken, deriveName(input.name, { ext }))
      const dest = join(outDir, name)

      await callInference(settings, '/remove-background', {
        in_path: input.path,
        out_path: dest,
        model: params.model,
        background: params.background ?? null,
        feather: params.feather,
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
