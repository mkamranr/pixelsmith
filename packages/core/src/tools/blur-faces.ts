import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { BadInputError } from '../errors.js'
import { callInference, withOrientedCopy } from '../inference.js'
import { deriveName, uniqueName } from '../naming.js'
import { MIME_BY_FORMAT, RASTER_MIMES } from '../pipeline.js'
import type { Tool } from '../registry.js'

/** An area the operator marked by hand, in source pixels. */
export const RedactRegion = z.object({
  /**
   * Which uploaded photo this area belongs to, counted from zero. Absent means
   * every photo, which is what the parameter meant before areas could be drawn
   * per photo — useful for a batch of identically laid out scans where the same
   * corner is covered on each, and what a caller written against the older
   * shape still gets.
   */
  file: z.coerce.number().int().min(0).optional(),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
  width: z.coerce.number().int().positive(),
  height: z.coerce.number().int().positive(),
})

export type RedactRegion = z.infer<typeof RedactRegion>

export const BlurFacesParams = z
  .object({
    method: z.enum(['blur', 'pixelate', 'box']).default('blur'),
    strength: z.coerce.number().int().min(1).max(200).default(24),
    /** Percentage in the UI, sent to the detector as a fraction. */
    confidence: z.coerce.number().int().min(1).max(100).default(70),
    /** Run the detector. Off means redact only what the operator marked. */
    detect: z.boolean().default(true),
    /** JSON array of manual areas, added or corrected in the browser. */
    regions: z.string().max(100_000).optional(),
  })
  .superRefine((v, ctx) => {
    // Detection off with nothing marked cannot change the image. Handing back
    // an untouched file that the user believes is redacted is the one outcome
    // this tool must never produce.
    if (!v.detect && parseRegionsOrEmpty(v.regions).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['regions'],
        message: 'with automatic detection off, mark at least one area to obscure',
      })
    }
  })

/** Lenient parse used during validation; the strict one runs in `run`. */
function parseRegionsOrEmpty(raw: string | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Strict parse. A region list we cannot read is an error, never an empty list. */
export function parseRegions(raw: string | undefined): RedactRegion[] {
  if (!raw || raw.trim() === '') return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new BadInputError('the marked areas could not be read')
  }
  const parsed = z.array(RedactRegion).max(200).safeParse(json)
  if (!parsed.success) {
    throw new BadInputError(`a marked area is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
  }
  return parsed.data
}

export type BlurFacesParams = z.infer<typeof BlurFacesParams>

interface RedactResult {
  detected: number
  regions: number
}

export const blurFaces: Tool<BlurFacesParams> = {
  id: 'blur-faces',
  title: 'Blur faces',
  family: 'image',
  queue: 'ml',
  accepts: [...RASTER_MIMES],
  params: BlurFacesParams,
  ui: {
    group: 'secure',
    icon: 'user-x',
    preview: 'none',
    surface: 'canvas',
    imageEdit: 'boxes',
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
        // Written by the box editor, one entry per area with the photo it
        // belongs to. Declared here because a value that exists only in the
        // schema is dropped on the way in, however correct the schema is.
        name: 'regions',
        label: 'Marked areas',
        kind: 'hidden',
      },
      {
        name: 'detect',
        label: 'Find faces automatically',
        kind: 'toggle',
        default: true,
        help: 'Turn off to obscure only the areas you mark yourself.',
      },
      {
        name: 'confidence',
        label: 'Detection sensitivity',
        kind: 'segmented',
        default: '70',
        showWhen: { field: 'detect', equals: ['true'] },
        options: [
          { value: '40', label: 'High' },
          { value: '70', label: 'Recommended' },
          { value: '90', label: 'Low' },
        ],
      },
    ],
  },

  async run({ inputs, outDir, params, settings, onProgress }) {
    const taken = new Set<string>()
    const outputs = []

    const regions = parseRegions(params.regions)

    // A face the operator marked, silently not obscured because the area
    // pointed at a photo that is not here, is the one outcome this tool cannot
    // have. So it is refused rather than dropped.
    const dangling = regions.find((r) => r.file !== undefined && r.file >= inputs.length)
    if (dangling !== undefined) {
      throw new BadInputError(
        `a marked area belongs to photo ${dangling.file! + 1}, but only ${inputs.length} ${
          inputs.length === 1 ? 'was' : 'were'
        } uploaded`,
      )
    }

    for (const [index, input] of inputs.entries()) {
      const ext = extname(input.name).replace('.', '').toLowerCase() || 'png'
      const name = uniqueName(taken, deriveName(input.name, { ext }))
      const dest = join(outDir, name)

      const result = await withOrientedCopy(input.path, (orientedPath) =>
        callInference<RedactResult>(settings, '/blur-faces', {
          in_path: orientedPath,
          out_path: dest,
          method: params.method,
          strength: params.strength,
          confidence: params.confidence / 100,
          detect: params.detect,
          // This photo's own areas, plus any meant for the whole batch. The
          // photo index is the client's bookkeeping and means nothing to the
          // detector, so it is not sent.
          extra_regions: regions
            .filter((r) => r.file === undefined || r.file === index)
            .map(({ file: _file, ...rect }) => rect),
        }),
      )

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
