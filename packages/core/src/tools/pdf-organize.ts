import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, degrees } from 'pdf-lib'
import { z } from 'zod'
import { BadInputError } from '../errors.js'
import { parsePageRanges, toIndices } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { uniqueName } from '../naming.js'
import type { OutputFile, Tool } from '../registry.js'

/** PDF page rotation is stored in quarter turns, and nothing else is valid. */
const QUARTER_TURNS = [0, 90, 180, 270]

/** One page of the result: where it comes from, and which way up. */
export const PlanEntry = z.object({
  /** Which of the uploaded documents, counted from zero. */
  file: z.coerce.number().int().min(0),
  /** Which page of that document, counted from one. */
  page: z.coerce.number().int().positive(),
  rotate: z.coerce
    .number()
    .refine((turn) => QUARTER_TURNS.includes(turn), {
      message: 'each turn must be 0, 90, 180 or 270 degrees',
    })
    .default(0),
})

export type PlanEntry = z.infer<typeof PlanEntry>

const PlanArray = z.array(PlanEntry).min(1).max(5000)

/** Strict parse. An arrangement we cannot read is an error, never an empty one. */
export function parsePlan(raw: string): PlanEntry[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new BadInputError('the arrangement could not be read')
  }

  const parsed = PlanArray.safeParse(json)
  if (!parsed.success) {
    throw new BadInputError(
      `the arrangement is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    )
  }
  return parsed.data
}

export const OrganizePdfParams = z
  .object({
    /**
     * The exact sequence of the result, across every document uploaded.
     *
     * A separate parameter from `pages` rather than a cleverer spelling of it,
     * because it is a different instruction: a page range reorders one
     * document, while this draws from several and can turn pages as it goes.
     * Written by the workspace as the pages are dragged about.
     */
    plan: z.string().max(500_000).optional(),
    /**
     * The page order within a single document, for anyone working without the
     * script. Pages left out are removed and the order given is the new order.
     */
    pages: z.string().trim().max(400).optional(),
  })
  .superRefine((value, ctx) => {
    const listed = (value.pages ?? '').trim() !== ''
    const raw = (value.plan ?? '').trim()

    if (raw === '') {
      if (!listed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'arrange the pages, or give the order you want as a list',
          path: ['pages'],
        })
      }
      return
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the arrangement could not be read',
        path: ['plan'],
      })
      return
    }

    const parsed = PlanArray.safeParse(json)
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `the arrangement is not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        path: ['plan'],
      })
    }
  })

export type OrganizePdfParams = z.infer<typeof OrganizePdfParams>

export const organizePdf: Tool<OrganizePdfParams> = {
  id: 'organize-pdf',
  title: 'Organise PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: OrganizePdfParams,
  ui: {
    group: 'organise',
    icon: 'sliders',
    surface: 'pdforganize',
    preview: 'none',
    blurb:
      'Lay every page of every document out together, then drag them into the order you want. Turn a page, drop one, or use one twice — what comes out is one document arranged exactly as you left it.',
    fields: [
      // Written by the workspace as pages are dragged, turned and dropped.
      { name: 'plan', label: 'Arrangement', kind: 'hidden' },
      {
        name: 'pages',
        label: 'Page order',
        kind: 'text',
        help: 'For example 3,1,2 to reorder, 1,5 to keep only those, or 1,1,2 to use page one twice.',
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const raw = (params.plan ?? '').trim()

    if (raw !== '') {
      const entries = parsePlan(raw)
      const organised = await PDFDocument.create()
      /** Each document opened once, however many of its pages are used. */
      const opened = new Map<number, PDFDocument>()

      for (const [at, entry] of entries.entries()) {
        const input = inputs[entry.file]
        if (!input) {
          throw new BadInputError(
            `the arrangement refers to document ${entry.file + 1}, but ${inputs.length} ${
              inputs.length === 1 ? 'was' : 'were'
            } given`,
          )
        }

        let source = opened.get(entry.file)
        if (!source) {
          source = await loadPdf(input.path)
          opened.set(entry.file, source)
        }

        const count = source.getPageCount()
        if (entry.page > count) {
          throw new BadInputError(
            `page ${entry.page} is past the end of ${input.name}, which has ${count}`,
          )
        }

        const [copied] = await organised.copyPages(source, [entry.page - 1])
        if (entry.rotate !== 0) {
          // Added to what the page already carries: a scan saved sideways is
          // already at 90, and another quarter turn makes 180.
          const angle = copied!.getRotation().angle
          copied!.setRotation(degrees((((angle + entry.rotate) % 360) + 360) % 360))
        }
        organised.addPage(copied!)
        onProgress?.((at + 1) / entries.length)
      }

      const name = 'organised.pdf'
      const dest = join(outDir, name)
      await writeFile(dest, await organised.save())
      return [{ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size }]
    }

    const taken = new Set<string>()
    const outputs: OutputFile[] = []

    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const selected = parsePageRanges(params.pages, source.getPageCount())

      const organised = await PDFDocument.create()
      // copyPages preserves the requested order, including repeats.
      const copied = await organised.copyPages(source, toIndices(selected))
      for (const page of copied) organised.addPage(page)

      const name = uniqueName(taken, input.name)
      const dest = join(outDir, name)
      await writeFile(dest, await organised.save())
      outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
