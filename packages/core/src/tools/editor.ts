import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { BadInputError, LimitExceededError } from '../errors.js'
import { deriveName, uniqueName } from '../naming.js'
import { EXT_BY_FORMAT, MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import { escapeXml, FONT_STACK } from '../text.js'
import type { Tool } from '../registry.js'

/** A proportion of the image, so a preview-sized edit maps to any resolution. */
const fraction = z.coerce.number().min(0).max(1)
const factor = z.coerce.number().min(0.05).max(4)

/**
 * One editing step.
 *
 * Geometry is expressed in *fractions* rather than pixels. The browser edits a
 * downscaled preview, so pixel coordinates from that preview would land in the
 * wrong place on the full-resolution original. Fractions survive the change of
 * scale exactly.
 */
const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('crop'), x: fraction, y: fraction, width: fraction, height: fraction }),
  z.object({ op: z.literal('rotate'), angle: z.coerce.number().min(-360).max(360) }),
  z.object({ op: z.literal('flip') }),
  z.object({ op: z.literal('flop') }),
  z.object({
    op: z.literal('resize'),
    width: z.coerce.number().int().positive().max(20_000).optional(),
    height: z.coerce.number().int().positive().max(20_000).optional(),
  }),
  z.object({ op: z.literal('brightness'), value: factor }),
  z.object({ op: z.literal('saturation'), value: factor }),
  z.object({ op: z.literal('contrast'), value: factor }),
  z.object({ op: z.literal('greyscale') }),
  z.object({ op: z.literal('blur'), sigma: z.coerce.number().min(0.3).max(50) }),
  z.object({ op: z.literal('sharpen'), sigma: z.coerce.number().min(0.3).max(10) }),
  z.object({
    op: z.literal('text'),
    text: z.string().min(1).max(300),
    x: fraction,
    y: fraction,
    size: z.coerce.number().min(0.01).max(1),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
    weight: z.enum(['400', '600', '700']).default('700'),
  }),
])

export type EditOp = z.infer<typeof EditOp>

export const EditRecipe = z.object({
  /**
   * Pinned, not a minimum. An unrecognised version means the server cannot
   * promise the same result the user approved in the preview, and quietly doing
   * something approximate is worse than refusing.
   */
  version: z.literal(1),
  ops: z.array(EditOp).max(200),
})

export type EditRecipe = z.infer<typeof EditRecipe>

export const EditorParams = z.object({
  /** JSON, because it arrives as one hidden form field from the editor page. */
  recipe: z.string().min(2).max(200_000),
  format: z.enum(['keep', 'jpeg', 'png', 'webp']).default('keep'),
  quality: z.coerce.number().int().min(1).max(100).default(90),
})

export type EditorParams = z.infer<typeof EditorParams>

function parseRecipe(raw: string): EditRecipe {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new BadInputError('the edit recipe was not valid JSON')
  }
  const parsed = EditRecipe.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new BadInputError(`the edit recipe is not valid: ${first?.path.join('.')} ${first?.message}`)
  }
  return parsed.data
}

/**
 * Apply one operation and hand back the resulting bytes.
 *
 * Each step is materialised rather than chained into a single sharp pipeline.
 * That costs an encode per step, but it makes the ops genuinely order
 * independent — libvips applies `extract` and `rotate` in its own order within
 * one pipeline, which silently produces the wrong crop after a rotation.
 */
async function applyOp(buffer: Buffer, op: EditOp): Promise<Buffer> {
  const img = sharp(buffer, { limitInputPixels: 200_000_000 })
  const meta = await img.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0

  switch (op.op) {
    case 'crop': {
      const left = Math.round(op.x * width)
      const top = Math.round(op.y * height)
      const cropWidth = Math.max(1, Math.round(op.width * width))
      const cropHeight = Math.max(1, Math.round(op.height * height))
      if (left + cropWidth > width || top + cropHeight > height) {
        throw new LimitExceededError(
          'crop bounds',
          `the selected area falls outside the ${width}x${height} image`,
        )
      }
      return img.extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer()
    }
    case 'rotate':
      return img.rotate(op.angle, { background: '#00000000' }).toBuffer()
    case 'flip':
      return img.flip().toBuffer()
    case 'flop':
      return img.flop().toBuffer()
    case 'resize':
      return img
        .resize({
          ...(op.width !== undefined ? { width: op.width } : {}),
          ...(op.height !== undefined ? { height: op.height } : {}),
          fit: 'inside',
        })
        .toBuffer()
    case 'brightness':
      return img.modulate({ brightness: op.value }).toBuffer()
    case 'saturation':
      return img.modulate({ saturation: op.value }).toBuffer()
    case 'contrast':
      // Pivot around mid-grey so raising contrast does not also brighten.
      return img.linear(op.value, 128 * (1 - op.value)).toBuffer()
    case 'greyscale':
      return img.greyscale().toBuffer()
    case 'blur':
      return img.blur(op.sigma).toBuffer()
    case 'sharpen':
      return img.sharpen({ sigma: op.sigma }).toBuffer()
    case 'text': {
      const fontSize = Math.max(8, Math.round(op.size * Math.min(width, height)))
      const overlay = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
          `<text x="${Math.round(op.x * width)}" y="${Math.round(op.y * height)}" ` +
          `text-anchor="middle" dominant-baseline="middle" ` +
          `font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="${op.weight}" ` +
          `fill="${op.color}">${escapeXml(op.text)}</text></svg>`,
      )
      return img.composite([{ input: overlay, top: 0, left: 0 }]).toBuffer()
    }
  }
}

export const editor: Tool<EditorParams> = {
  id: 'editor',
  title: 'Photo editor',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: EditorParams,
  ui: {
    group: 'modify',
    icon: 'sliders',
    blurb: 'Crop, straighten, adjust and annotate — edited live in the browser, rendered at full size on the server.',
    // Driven by its own editor page rather than the generic options form.
    fields: [],
    surface: 'editor',
  },

  async run({ inputs, outDir, params, onProgress }) {
    const recipe = parseRecipe(params.recipe)
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      let buffer = await readFile(input.path)
      for (const op of recipe.ops) {
        buffer = await applyOp(buffer, op)
      }

      const sourceFormat = (await sharp(buffer).metadata()).format ?? 'png'
      const target = params.format === 'keep' ? sourceFormat : params.format
      const ext = EXT_BY_FORMAT[target] ?? extname(input.name).replace('.', '') ?? 'png'

      // Re-encode once at the end, at the requested quality.
      const finished = sharp(buffer)
      let encoded: Buffer
      switch (target) {
        case 'jpeg':
          encoded = await finished.flatten({ background: '#ffffff' }).jpeg({ quality: params.quality, mozjpeg: true }).toBuffer()
          break
        case 'webp':
          encoded = await finished.webp({ quality: params.quality }).toBuffer()
          break
        case 'png':
          encoded = await finished.png({ compressionLevel: 9 }).toBuffer()
          break
        default:
          encoded = buffer
      }

      const name = uniqueName(taken, deriveName(input.name, { ext }))
      const dest = join(outDir, name)
      await writeFile(dest, encoded)

      outputs.push({
        path: dest,
        name,
        mime: MIME_BY_FORMAT[target] ?? 'application/octet-stream',
        bytes: (await stat(dest)).size,
      })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
