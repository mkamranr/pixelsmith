import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { BadInputError, LimitExceededError } from '../errors.js'
import { deriveName, uniqueName } from '../naming.js'
import { EXT_BY_FORMAT, MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import { escapeXml, FONT_STACK } from '../text.js'
import { stickerById, STICKER_IDS } from '../stickers.js'
import type { Tool } from '../registry.js'

/** A proportion of the image, so a preview-sized edit maps to any resolution. */
const fraction = z.coerce.number().min(0).max(1)
const HEX = z.string().regex(/^#[0-9a-f]{6}$/i)
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
    op: z.literal('shape'),
    shape: z.enum(['rect', 'ellipse', 'line']),
    x: fraction,
    y: fraction,
    width: fraction,
    height: fraction,
    color: HEX.default('#ff3b30'),
    fill: z.boolean().default(true),
    /** Stroke weight as a fraction of the image's shorter side. */
    strokeWidth: z.coerce.number().min(0.002).max(0.2).default(0.008),
  }),
  z.object({
    op: z.literal('draw'),
    /** A freehand stroke, sampled into points. Two is the minimum that draws. */
    points: z.array(z.object({ x: fraction, y: fraction })).min(2).max(4000),
    color: HEX.default('#ff3b30'),
    width: z.coerce.number().min(0.002).max(0.2).default(0.01),
  }),
  z.object({
    op: z.literal('frame'),
    /** Border thickness as a fraction of the shorter side. */
    width: z.coerce.number().min(0.005).max(0.3).default(0.04),
    color: HEX.default('#ffffff'),
  }),
  z.object({
    op: z.literal('sticker'),
    sticker: z.enum(STICKER_IDS),
    x: fraction,
    y: fraction,
    /** Width as a fraction of the image's shorter side. */
    size: z.coerce.number().min(0.02).max(1.5),
    color: HEX.default('#ff3b30'),
    rotation: z.coerce.number().min(-180).max(180).default(0),
  }),
  z.object({
    op: z.literal('background'),
    color: HEX,
  }),
  z.object({
    op: z.literal('corners'),
    /** Corner radius as a fraction of the shorter side. */
    radius: z.coerce.number().min(0.01).max(0.5).default(0.08),
  }),
  z.object({
    op: z.literal('filter'),
    preset: z.enum(['none', 'mono', 'sepia', 'vivid', 'warm', 'cool', 'fade']),
  }),
  z.object({
    op: z.literal('text'),
    text: z.string().min(1).max(300),
    x: fraction,
    y: fraction,
    size: z.coerce.number().min(0.01).max(1),
    color: HEX.default('#ffffff'),
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
  ops: z.array(EditOp).max(400),
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

/** Wrap SVG content in a layer the size of the image, ready to composite. */
function svgLayer(width: number, height: number, content: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${content}</svg>`,
  )
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
    case 'shape': {
      const short = Math.min(width, height)
      const stroke = Math.max(1, Math.round(op.strokeWidth * short))
      const px = {
        x: op.x * width,
        y: op.y * height,
        w: op.width * width,
        h: op.height * height,
      }

      let element: string
      if (op.shape === 'line') {
        // A line uses width/height as a delta from its origin, so it can be
        // drawn at any angle rather than only axis-aligned.
        element =
          `<line x1="${px.x.toFixed(1)}" y1="${px.y.toFixed(1)}" ` +
          `x2="${(px.x + px.w).toFixed(1)}" y2="${(px.y + px.h).toFixed(1)}" ` +
          `stroke="${op.color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      } else if (op.shape === 'ellipse') {
        element =
          `<ellipse cx="${(px.x + px.w / 2).toFixed(1)}" cy="${(px.y + px.h / 2).toFixed(1)}" ` +
          `rx="${(px.w / 2).toFixed(1)}" ry="${(px.h / 2).toFixed(1)}" ` +
          (op.fill ? `fill="${op.color}"` : `fill="none" stroke="${op.color}" stroke-width="${stroke}"`) +
          '/>'
      } else {
        element =
          `<rect x="${px.x.toFixed(1)}" y="${px.y.toFixed(1)}" ` +
          `width="${px.w.toFixed(1)}" height="${px.h.toFixed(1)}" ` +
          (op.fill ? `fill="${op.color}"` : `fill="none" stroke="${op.color}" stroke-width="${stroke}"`) +
          '/>'
      }

      return img.composite([{ input: svgLayer(width, height, element), top: 0, left: 0 }]).toBuffer()
    }

    case 'draw': {
      const stroke = Math.max(1, Math.round(op.width * Math.min(width, height)))
      const path = op.points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${(point.x * width).toFixed(1)},${(point.y * height).toFixed(1)}`)
        .join(' ')
      const element =
        `<path d="${path}" fill="none" stroke="${op.color}" stroke-width="${stroke}" ` +
        'stroke-linecap="round" stroke-linejoin="round"/>'
      return img.composite([{ input: svgLayer(width, height, element), top: 0, left: 0 }]).toBuffer()
    }

    case 'frame': {
      const thickness = Math.max(1, Math.round(op.width * Math.min(width, height)))
      // Drawn inside the image so the dimensions do not change. The rect is
      // inset by half the stroke because SVG strokes straddle the path.
      const inset = thickness / 2
      const element =
        `<rect x="${inset}" y="${inset}" width="${width - thickness}" height="${height - thickness}" ` +
        `fill="none" stroke="${op.color}" stroke-width="${thickness}"/>`
      return img.composite([{ input: svgLayer(width, height, element), top: 0, left: 0 }]).toBuffer()
    }

    case 'corners': {
      const radius = Math.round(op.radius * Math.min(width, height))
      // dest-in keeps the image only where the mask is opaque, so the corners
      // become genuinely transparent rather than painted a background colour.
      const mask = svgLayer(
        width,
        height,
        `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/>`,
      )
      return img
        .ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer()
    }

    case 'sticker': {
      const sticker = stickerById(op.sticker)
      // The schema restricts the id to the catalogue, so this cannot normally
      // happen; refusing loudly beats drawing nothing and looking successful.
      if (!sticker) throw new BadInputError(`unknown sticker: ${op.sticker}`)

      const extent = Math.max(8, Math.round(op.size * Math.min(width, height)))
      const left = Math.round(op.x * width - extent / 2)
      const top = Math.round(op.y * height - extent / 2)
      const spin = op.rotation
        ? ` transform="rotate(${op.rotation} ${extent / 2} ${extent / 2})"`
        : ''

      // Rendered at its final size rather than scaled afterwards, so the edges
      // stay sharp however large the sticker is.
      const mark = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="${sticker.viewBox}">` +
          `<g${spin}><path d="${sticker.path}" fill="${op.color}" fill-rule="evenodd"/></g></svg>`,
      )

      return img
        .composite([{ input: mark, top: Math.max(0, top), left: Math.max(0, left) }])
        .toBuffer()
    }

    case 'background': {
      // Flatten transparency onto a colour. Useful after rounding corners or
      // removing a background, where the result would otherwise be see-through.
      return img.flatten({ background: op.color }).toBuffer()
    }

    case 'filter': {
      switch (op.preset) {
        case 'mono':
          return img.greyscale().toBuffer()
        case 'sepia':
          return img.greyscale().tint({ r: 196, g: 154, b: 106 }).toBuffer()
        case 'vivid':
          return img.modulate({ saturation: 1.4 }).linear(1.08, -10).toBuffer()
        case 'warm':
          return img.tint({ r: 255, g: 226, b: 196 }).toBuffer()
        case 'cool':
          return img.tint({ r: 198, g: 222, b: 255 }).toBuffer()
        case 'fade':
          return img.modulate({ saturation: 0.68 }).linear(0.88, 26).toBuffer()
        default:
          return img.toBuffer()
      }
    }

    case 'text': {
      const fontSize = Math.max(8, Math.round(op.size * Math.min(width, height)))
      const element =
        `<text x="${Math.round(op.x * width)}" y="${Math.round(op.y * height)}" ` +
        'text-anchor="middle" dominant-baseline="middle" ' +
        `font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="${op.weight}" ` +
        `fill="${op.color}">${escapeXml(op.text)}</text>`
      return img.composite([{ input: svgLayer(width, height, element), top: 0, left: 0 }]).toBuffer()
    }
  }
}

export const editor: Tool<EditorParams> = {
  id: 'editor',
  title: 'Photo editor',
  family: 'image',
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
