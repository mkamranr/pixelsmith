import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { encodeAs, MIME_BY_FORMAT, openImage, RASTER_MIMES } from '../pipeline.js'
import { uniqueName } from '../naming.js'
import { escapeXml, FONT_STACK, wrapText } from '../text.js'
import type { Tool } from '../registry.js'

const nonEmpty = (s?: string) => (s ?? '').trim().length > 0

export const MemeParams = z
  .object({
    top: z.string().max(200).optional(),
    bottom: z.string().max(200).optional(),
    /** Omitted means scale with the image. */
    fontSize: z.number().int().min(10).max(300).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
    strokeColor: z.string().regex(/^#[0-9a-f]{6}$/i).default('#000000'),
    uppercase: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (!nonEmpty(v.top) && !nonEmpty(v.bottom)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['top'], message: 'write a caption for the top or the bottom' })
    }
  })

export type MemeParams = z.infer<typeof MemeParams>

/**
 * Render caption lines anchored to the top or bottom edge.
 *
 * The heavy outline is what keeps white text readable over a light photo, and
 * `paint-order: stroke` draws it behind the fill so the letterforms stay crisp
 * rather than being eaten into by the stroke.
 */
function captionSvg(
  text: string,
  edge: 'top' | 'bottom',
  width: number,
  height: number,
  size: number,
  params: MemeParams,
): string {
  const content = params.uppercase ? text.toUpperCase() : text
  const lines = wrapText(content, width * 0.92, size)
  const lineHeight = size * 1.12
  const margin = Math.round(size * 0.5)

  return lines
    .map((line, i) => {
      const y =
        edge === 'top'
          ? margin + size + i * lineHeight
          : height - margin - (lines.length - 1 - i) * lineHeight
      return (
        `<text x="${(width / 2).toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle"` +
        ` font-family="${FONT_STACK}" font-size="${size}" font-weight="bold"` +
        ` fill="${params.color}" stroke="${params.strokeColor}" stroke-width="${(size * 0.06).toFixed(2)}"` +
        ` style="paint-order:stroke fill">${escapeXml(line)}</text>`
      )
    })
    .join('')
}

export const meme: Tool<MemeParams> = {
  id: 'meme',
  title: 'Meme generator',
  queue: 'image',
  accepts: [...RASTER_MIMES],
  params: MemeParams,
  ui: {
    group: 'create',
    icon: 'message-square',
    preview: 'caption',
    blurb: 'Add bold captions across the top and bottom of any picture.',
    fields: [
      { name: 'top', label: 'Top caption', kind: 'text' },
      { name: 'bottom', label: 'Bottom caption', kind: 'text' },
      { name: 'uppercase', label: 'Force capitals', kind: 'toggle', default: true },
      { name: 'fontSize', label: 'Text size (px)', kind: 'number', min: 10, max: 300, help: 'Leave blank to scale with the image.' },
      { name: 'color', label: 'Text colour', kind: 'color', default: '#ffffff' },
      { name: 'strokeColor', label: 'Outline colour', kind: 'color', default: '#000000' },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    for (const [index, input] of inputs.entries()) {
      const probe = await sharp(input.path).metadata()
      const width = probe.width ?? 0
      const height = (probe.pages && probe.pages > 1 ? probe.pageHeight : probe.height) ?? 0
      const format = probe.format ?? 'png'
      const size = params.fontSize ?? Math.max(18, Math.round(Math.min(width, height) / 10))

      const parts: string[] = []
      if (nonEmpty(params.top)) parts.push(captionSvg(params.top!, 'top', width, height, size, params))
      if (nonEmpty(params.bottom)) parts.push(captionSvg(params.bottom!, 'bottom', width, height, size, params))

      const overlay = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`,
      )

      const img = openImage(input.path, { animated: false }).composite([{ input: overlay, top: 0, left: 0 }])

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
