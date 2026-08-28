import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import { escapeXml, FONT_STACK } from '../text.js'
import { BadInputError } from '../errors.js'
import type { Tool } from '../registry.js'

const POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

export const WatermarkParams = z
  .object({
    /** Stamp words, or stamp a supplied logo. */
    mark: z.enum(['text', 'image']).default('text'),
    text: z.string().trim().max(200).optional(),
    /** Logo width as a percentage of the base image width. */
    markScale: z.coerce.number().int().min(2).max(100).default(25),
  position: z.enum(POSITIONS).default('bottom-right'),
  /**
   * Where the mark sits, as a fraction of the image. Nine positions is nine
   * answers to a question with infinitely many, so dragging the mark writes
   * these; `position` remains for anyone who would rather just say "bottom
   * right", and is what applies when these are absent.
   */
  x: z.coerce.number().min(0).max(1).optional(),
  y: z.coerce.number().min(0).max(1).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
  opacity: z.number().int().min(1).max(100).default(45),
  /** Omitted means scale with the image, so one setting suits any size. */
  fontSize: z.number().int().min(8).max(400).optional(),
    rotation: z.coerce.number().min(-90).max(90).default(0),
    tiled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    // Text is only meaningful in text mode; requiring it unconditionally would
    // make an image watermark impossible to submit.
    if (v.mark === 'text' && (v.text ?? '').trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'Required' })
    }
  })

export type WatermarkParams = z.infer<typeof WatermarkParams>

interface Placement {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
}

function placement(
  params: Pick<WatermarkParams, 'position' | 'x' | 'y'>,
  w: number,
  h: number,
  pad: number,
  size: number,
): Placement {
  // Coordinates win where they are given: they are what dragging produces, and
  // they can say things the nine presets cannot.
  if (params.x !== undefined || params.y !== undefined) {
    const x = (params.x ?? 0.5) * w
    const y = (params.y ?? 0.5) * h
    return {
      // Kept inside the image, so a mark dragged to the very edge is not
      // half-clipped by its own baseline.
      x: Math.min(w - pad, Math.max(pad, x)),
      y: Math.min(h - pad, Math.max(pad + size, y + size)),
      anchor: 'middle',
    }
  }

  switch (params.position) {
    case 'top-left':
      return { x: pad, y: pad + size, anchor: 'start' }
    case 'top-right':
      return { x: w - pad, y: pad + size, anchor: 'end' }
    case 'bottom-left':
      return { x: pad, y: h - pad, anchor: 'start' }
    case 'bottom-right':
      return { x: w - pad, y: h - pad, anchor: 'end' }
    default:
      return { x: w / 2, y: h / 2, anchor: 'middle' }
  }
}

/** Build the overlay as an SVG the same size as the image, then composite it. */
function buildOverlay(params: WatermarkParams, width: number, height: number): Buffer {
  const size = params.fontSize ?? Math.max(14, Math.round(width / 18))
  const safeText = escapeXml(params.text ?? '')
  const opacity = (params.opacity / 100).toFixed(3)
  const safe = safeText
  const common = `font-family="${FONT_STACK}" font-size="${size}" font-weight="600" fill="${params.color}" fill-opacity="${opacity}"`

  let body: string
  if (params.tiled) {
    // A diagonal lattice, the pattern that is hardest to crop or paint out.
    const stepX = Math.max(size * 6, 120)
    const stepY = Math.max(size * 4, 90)
    const cells: string[] = []
    for (let y = stepY / 2; y < height + stepY; y += stepY) {
      for (let x = stepX / 2; x < width + stepX; x += stepX) {
        cells.push(
          `<text x="${x.toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle" ${common}` +
            ` transform="rotate(-30 ${x.toFixed(0)} ${y.toFixed(0)})">${safe}</text>`,
        )
      }
    }
    body = cells.join('')
  } else {
    const pad = Math.round(size * 0.75)
    const at = placement(params, width, height, pad, size)
    const rotate = params.rotation !== 0 ? ` transform="rotate(${params.rotation} ${at.x} ${at.y})"` : ''
    body = `<text x="${at.x.toFixed(0)}" y="${at.y.toFixed(0)}" text-anchor="${at.anchor}" ${common}${rotate}>${safe}</text>`
  }

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)
}

/**
 * Prepare a logo overlay: scaled to the base image, faded to the requested
 * opacity, and placed or tiled.
 *
 * Opacity is applied by multiplying the logo's existing alpha with a solid
 * tile using the `dest-in` blend. Setting alpha directly would discard the
 * logo's own transparency and stamp a rectangle.
 */
async function buildImageOverlay(
  markPath: string,
  params: WatermarkParams,
  width: number,
  height: number,
): Promise<sharp.OverlayOptions> {
  const targetWidth = Math.max(8, Math.round((width * params.markScale) / 100))

  const scaled = await sharp(markPath)
    .resize({ width: targetWidth, fit: 'inside', withoutEnlargement: false })
    .ensureAlpha()
    .png()
    .toBuffer()

  const alpha = Math.round((params.opacity / 100) * 255)
  const faded = await sharp(scaled)
    .composite([
      {
        input: Buffer.from([255, 255, 255, alpha]),
        raw: { width: 1, height: 1, channels: 4 },
        tile: true,
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer()

  if (params.tiled) {
    return { input: faded, tile: true, blend: 'over' }
  }

  const meta = await sharp(faded).metadata()
  const markWidth = meta.width ?? targetWidth
  const markHeight = meta.height ?? targetWidth
  const pad = Math.round(width * 0.03)

  const left =
    params.position === 'center'
      ? Math.round((width - markWidth) / 2)
      : params.position.includes('left')
        ? pad
        : Math.max(0, width - markWidth - pad)

  const top =
    params.position === 'center'
      ? Math.round((height - markHeight) / 2)
      : params.position.startsWith('top')
        ? pad
        : Math.max(0, height - markHeight - pad)

  return { input: faded, left: Math.max(0, left), top: Math.max(0, top) }
}

export const watermark: Tool<WatermarkParams> = {
  id: 'watermark',
  title: 'Watermark images',
  family: 'image',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: WatermarkParams,
  ui: {
    group: 'secure',
    icon: 'stamp',
    preview: 'watermark',
    surface: 'canvas',
    blurb: 'Stamp text across images before they leave your hands — one corner, or tiled across the whole frame.',
    fields: [
      {
        name: 'mark',
        label: 'Watermark with',
        kind: 'segmented',
        default: 'text',
        options: [
          { value: 'text', label: 'Add text' },
          { value: 'image', label: 'Add image' },
        ],
      },
      {
        name: 'text',
        label: 'Watermark text',
        kind: 'text',
        default: 'CONFIDENTIAL',
        showWhen: { field: 'mark', equals: ['text'] },
      },
      {
        name: 'markFile',
        label: 'Watermark image',
        kind: 'file',
        showWhen: { field: 'mark', equals: ['image'] },
        help: 'A PNG with transparency works best.',
      },
      {
        name: 'markScale',
        label: 'Logo size (% of width)',
        kind: 'number',
        min: 2,
        max: 100,
        default: 25,
        showWhen: { field: 'mark', equals: ['image'] },
      },
      {
        // Written by dragging the mark on the picture. Declared because a value
        // that exists only in the schema is dropped at intake, however correct
        // the schema is.
        name: 'x',
        label: 'From the left',
        kind: 'hidden',
      },
      { name: 'y', label: 'From the top', kind: 'hidden' },
      {
        name: 'position',
        label: 'Position',
        kind: 'select',
        default: 'bottom-right',
        options: [
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
          { value: 'center', label: 'Centre' },
        ],
      },
      { name: 'tiled', label: 'Tile across the whole image', kind: 'toggle', default: false },
      { name: 'color', label: 'Colour', kind: 'color', default: '#ffffff' },
      { name: 'opacity', label: 'Opacity (%)', kind: 'number', min: 1, max: 100, default: 45 },
      {
        name: 'fontSize',
        label: 'Text size (px)',
        kind: 'number',
        min: 8,
        max: 400,
        help: 'Leave blank to scale with the image.',
        showWhen: { field: 'mark', equals: ['text'] },
      },
    ],
  },

  async run({ inputs, outDir, params, assets, onProgress }) {
    // Resolve the logo once for the whole batch.
    const markPath = params.mark === 'image' ? assets.markFile : undefined
    if (params.mark === 'image' && !markPath) {
      throw new BadInputError('choose a watermark image to stamp, or switch to text')
    }

    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      // Watermarking a frame strip would stamp across the whole roll, so
      // animations are flattened to their first frame here.
      const width = probe.width ?? 0
      const height = (probe.pages && probe.pages > 1 ? probe.pageHeight : probe.height) ?? 0
      const format = probe.format ?? 'png'

      const overlay =
        markPath !== undefined
          ? await buildImageOverlay(markPath, params, width, height)
          : { input: buildOverlay(params, width, height), top: 0, left: 0 }

      const img = openImage(input.path, { animated: false }).composite([overlay])

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
