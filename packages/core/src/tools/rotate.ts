import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import type { Tool } from '../registry.js'

export const RotateParams = z.object({
  // Coerced, because the angle is presented as a select and HTML forms submit
  // "90" as a string. The JSON API can still send a real number.
  angle: z.coerce.number().min(-3600).max(3600).default(90),
  flip: z.boolean().default(false),
  flop: z.boolean().default(false),
  /** Fill colour revealed behind an off-axis rotation. */
  background: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
})

export type RotateParams = z.infer<typeof RotateParams>

export const rotate: Tool<RotateParams> = {
  id: 'rotate',
  title: 'Rotate & flip',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: RotateParams,
  ui: {
    group: 'modify',
    icon: 'rotate-cw',
    preview: 'transform',
    surface: 'canvas',
    blurb: 'Turn images by a quarter, a half, or any angle you like — and mirror them.',
    fields: [
      {
        name: 'angle',
        label: 'Rotation',
        kind: 'select',
        default: '90',
        options: [
          { value: '0', label: 'None' },
          { value: '90', label: '90° clockwise' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° anticlockwise' },
        ],
      },
      { name: 'flop', label: 'Mirror left to right', kind: 'toggle', default: false },
      { name: 'flip', label: 'Mirror top to bottom', kind: 'toggle', default: false },
      { name: 'background', label: 'Fill colour', kind: 'color', default: '#ffffff',
        help: 'Shown behind the image when rotating by an angle that is not a quarter turn.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    // 450° and -90° both mean the same quarter turn; normalise so libvips gets
    // a value it treats as a lossless right-angle rotation.
    const angle = ((params.angle % 360) + 360) % 360

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const animated = (probe.pages ?? 1) > 1
      const format = probe.format ?? 'png'

      let img = openImage(input.path, { animated })
      if (angle !== 0) img = img.rotate(angle, { background: params.background })
      if (params.flop) img = img.flop()
      if (params.flip) img = img.flip()

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
