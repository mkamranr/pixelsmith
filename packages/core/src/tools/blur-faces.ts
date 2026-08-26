import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { callInference } from '../inference.js'
import { deriveName, uniqueName } from '../naming.js'
import { MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import type { Tool } from '../registry.js'

export const BlurFacesParams = z.object({
  method: z.enum(['blur', 'pixelate', 'box']).default('blur'),
  strength: z.coerce.number().int().min(1).max(200).default(24),
  /** Percentage in the UI, sent to the detector as a fraction. */
  confidence: z.coerce.number().int().min(1).max(100).default(70),
})

export type BlurFacesParams = z.infer<typeof BlurFacesParams>

interface RedactResult {
  detected: number
  regions: number
}

export const blurFaces: Tool<BlurFacesParams> = {
  id: 'blur-faces',
  title: 'Blur faces',
  queue: 'ml',
  accepts: [...RASTER_MIMES],
  params: BlurFacesParams,
  ui: {
    group: 'secure',
    icon: 'user-x',
    preview: 'none',
    blurb: 'Find faces and obscure them before an image is shared. Detection runs on this machine.',
    fields: [
      {
        name: 'method',
        label: 'Obscure with',
        kind: 'select',
        default: 'blur',
        options: [
          { value: 'blur', label: 'Blur' },
          { value: 'pixelate', label: 'Pixelate' },
          { value: 'box', label: 'Solid black box' },
        ],
      },
      { name: 'strength', label: 'Strength', kind: 'number', min: 1, max: 200, default: 24 },
      {
        name: 'confidence',
        label: 'Detection threshold (%)',
        kind: 'number',
        min: 1,
        max: 100,
        default: 70,
        help: 'Lower finds more faces but also more false positives. Always check the result.',
      },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const ext = extname(input.name).replace('.', '').toLowerCase() || 'png'
      const name = uniqueName(taken, deriveName(input.name, { ext }))
      const dest = join(outDir, name)

      const result = await callInference<RedactResult>(settings, '/blur-faces', {
        in_path: input.path,
        out_path: dest,
        method: params.method,
        strength: params.strength,
        confidence: params.confidence / 100,
        detect: true,
        extra_regions: [],
      })

      outputs.push({
        path: dest,
        name,
        mime: MIME_BY_FORMAT[ext === 'jpg' ? 'jpeg' : ext] ?? 'image/png',
        bytes: (await stat(dest)).size,
        // Surfaced so the UI can say "no faces found" instead of silently
        // handing back an unchanged image.
        meta: { facesFound: result.detected ?? 0 },
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
