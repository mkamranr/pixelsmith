import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import { escapeXml, FONT_STACK } from '../text.js'
import type { Tool } from '../registry.js'

const POSITIONS = ['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

export const WatermarkParams = z.object({
  text: z.string().trim().min(1).max(200),
  position: z.enum(POSITIONS).default('bottom-right'),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
  opacity: z.number().int().min(1).max(100).default(45),
  /** Omitted means scale with the image, so one setting suits any size. */
  fontSize: z.number().int().min(8).max(400).optional(),
  rotation: z.number().min(-90).max(90).default(0),
  tiled: z.boolean().default(false),
})

export type WatermarkParams = z.infer<typeof WatermarkParams>

interface Placement {
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
}

function placement(position: (typeof POSITIONS)[number], w: number, h: number, pad: number, size: number): Placement {
  switch (position) {
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
  const opacity = (params.opacity / 100).toFixed(3)
  const safe = escapeXml(params.text)
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
    const at = placement(params.position, width, height, pad, size)
    const rotate = params.rotation !== 0 ? ` transform="rotate(${params.rotation} ${at.x} ${at.y})"` : ''
    body = `<text x="${at.x.toFixed(0)}" y="${at.y.toFixed(0)}" text-anchor="${at.anchor}" ${common}${rotate}>${safe}</text>`
  }

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)
}

export const watermark: Tool<WatermarkParams> = {
  id: 'watermark',
  title: 'Watermark images',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: WatermarkParams,
  ui: {
    group: 'secure',
    icon: 'stamp',
    preview: 'watermark',
    blurb: 'Stamp text across images before they leave your hands — one corner, or tiled across the whole frame.',
    fields: [
      { name: 'text', label: 'Watermark text', kind: 'text', default: 'CONFIDENTIAL' },
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
      { name: 'fontSize', label: 'Text size (px)', kind: 'number', min: 8, max: 400, help: 'Leave blank to scale with the image.' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      // Watermarking a frame strip would stamp across the whole roll, so
      // animations are flattened to their first frame here.
      const width = probe.width ?? 0
      const height = (probe.pages && probe.pages > 1 ? probe.pageHeight : probe.height) ?? 0
      const format = probe.format ?? 'png'

      const img = openImage(input.path, { animated: false }).composite([
        { input: buildOverlay(params, width, height), top: 0, left: 0 },
      ])

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
