import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const ResizeParams = z
  .object({
    mode: z.enum(['pixels', 'percent']).default('pixels'),
    width: z.number().int().positive().max(40_000).optional(),
    height: z.number().int().positive().max(40_000).optional(),
    percent: z.number().positive().max(1000).optional(),
    fit: z.enum(['inside', 'cover', 'fill']).default('inside'),
    /** On by default: silently upscaling someone's image is rarely wanted. */
    noEnlarge: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'pixels' && v.width === undefined && v.height === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'give a width, a height, or both' })
    }
    if (v.mode === 'percent' && v.percent === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percent'], message: 'give a percentage' })
    }
  })

export type ResizeParams = z.infer<typeof ResizeParams>

export const resize: Tool<ResizeParams> = {
  id: 'resize',
  title: 'Resize images',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: ResizeParams,
  ui: {
    group: 'modify',
    icon: 'scaling',
    preview: 'dimensions',
    blurb: 'Change the dimensions of one image or a whole batch, by pixels or by percentage.',
    fields: [
      {
        name: 'mode',
        label: 'Resize by',
        kind: 'select',
        default: 'pixels',
        options: [
          { value: 'pixels', label: 'Pixels' },
          { value: 'percent', label: 'Percentage' },
        ],
      },
      { name: 'width', label: 'Width (px)', kind: 'number', min: 1, max: 40000, showWhen: { field: 'mode', equals: ['pixels'] } },
      { name: 'height', label: 'Height (px)', kind: 'number', min: 1, max: 40000, showWhen: { field: 'mode', equals: ['pixels'] } },
      { name: 'percent', label: 'Scale (%)', kind: 'number', min: 1, max: 1000, default: 50, showWhen: { field: 'mode', equals: ['percent'] } },
      {
        name: 'fit',
        label: 'Fit',
        kind: 'select',
        default: 'inside',
        showWhen: { field: 'mode', equals: ['pixels'] },
        options: [
          { value: 'inside', label: 'Fit inside (keep proportions)' },
          { value: 'cover', label: 'Cover and crop' },
          { value: 'fill', label: 'Stretch to exact size' },
        ],
      },
      { name: 'noEnlarge', label: "Don't enlarge smaller images", kind: 'toggle', default: true },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const animated = (probe.pages ?? 1) > 1
      const img = openImage(input.path, { animated })

      let target: { width?: number; height?: number }
      if (params.mode === 'percent') {
        // Both dimensions are computed explicitly so the result is the same
        // number every time, rather than depending on libvips' rounding.
        const scale = params.percent! / 100
        target = {
          width: Math.max(1, Math.round((probe.width ?? 1) * scale)),
          height: Math.max(1, Math.round(((animated ? probe.pageHeight : probe.height) ?? 1) * scale)),
        }
      } else {
        target = {}
        if (params.width !== undefined) target.width = params.width
        if (params.height !== undefined) target.height = params.height
      }

      const format = probe.format ?? 'png'
      const resized = img.resize({
        ...target,
        fit: params.mode === 'percent' ? 'fill' : params.fit,
        withoutEnlargement: params.noEnlarge,
      })

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await encodeAs(resized, format).toFile(dest)

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
