import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { BadInputError } from '../errors.js'
import { parsePageRanges, toIndices } from '../pages.js'
import { loadPdf, PDF_MIME } from '../pdf.js'
import { deriveName, uniqueName } from '../naming.js'
import type { OutputFile, Tool } from '../registry.js'

export interface PageRange {
  from: number
  to: number
}

/** Inclusive run of page numbers. */
const sequence = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * Read a list of ranges, as `1-6,10-12` or a bare `3`.
 *
 * Unlike a page selection, the grouping matters here: each range becomes its
 * own document, so the ranges have to stay separate rather than collapsing into
 * one list of page numbers.
 */
export function parseSplitRanges(spec: string | undefined, pageCount: number): PageRange[] {
  const parts = (spec ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')

  if (parts.length === 0) {
    throw new BadInputError('add at least one range of pages to split on')
  }

  return parts.map((part) => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) {
      throw new BadInputError(`${JSON.stringify(part)} is not a page range — try 1-6 or 3`)
    }

    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])

    if (from < 1) throw new BadInputError('page numbers start at 1')
    if (to < from) throw new BadInputError(`range ${from}-${to} ends before it starts`)
    if (to > pageCount) {
      throw new BadInputError(`page ${to} is past the end of this ${pageCount}-page document`)
    }

    return { from, to }
  })
}

/**
 * Group pages so that each group stays within a size budget.
 *
 * Each page is measured on its own and the groups are packed by those figures.
 * Pages in one document share resources — fonts, repeated images — so a group
 * always comes out at or under the sum of its parts. The estimate therefore
 * errs towards smaller files, which is the safe direction when someone has
 * given a hard limit to stay under.
 */
async function packBySize(source: PDFDocument, maxBytes: number): Promise<number[][]> {
  const pageCount = source.getPageCount()
  const weights: number[] = []

  for (let page = 1; page <= pageCount; page++) {
    const single = await PDFDocument.create()
    const [copied] = await single.copyPages(source, [page - 1])
    single.addPage(copied!)
    weights.push((await single.save()).byteLength)
  }

  const groups: number[][] = []
  let current: number[] = []
  let total = 0

  for (let page = 1; page <= pageCount; page++) {
    const weight = weights[page - 1]!
    // A page over the limit on its own still has to go somewhere, and it cannot
    // be divided — so it goes out alone rather than being dropped.
    if (current.length > 0 && total + weight > maxBytes) {
      groups.push(current)
      current = []
      total = 0
    }
    current.push(page)
    total += weight
  }

  if (current.length > 0) groups.push(current)
  return groups
}

export const SplitPdfParams = z.object({
  mode: z.enum(['pages', 'ranges', 'fixed', 'size']).default('pages'),
  /** Custom ranges, one document each: `1-6,10-12`. */
  ranges: z.string().trim().max(2000).optional(),
  /** Pages per document, when splitting at a fixed interval. */
  every: z.coerce.number().int().min(1).max(5000).default(1),
  /** Which pages to keep. Blank means every page, separately. */
  pages: z.string().trim().max(400).optional(),
  /** Size budget per document, in megabytes. */
  maxMb: z.coerce.number().min(0.05).max(500).default(5),
  /** Put everything the split produced into one document instead. */
  mergeAll: z.boolean().default(false),
})

export type SplitPdfParams = z.infer<typeof SplitPdfParams>

interface Group {
  pages: number[]
  suffix: string
}

export const splitPdf: Tool<SplitPdfParams> = {
  id: 'split-pdf',
  title: 'Split PDF',
  family: 'pdf',
  queue: 'image',
  accepts: [PDF_MIME],
  params: SplitPdfParams,
  ui: {
    group: 'organise',
    icon: 'split',
    surface: 'canvas',
    preview: 'none',
    blurb:
      'Break a PDF up: every page on its own, the ranges you name, a fixed number of pages at a time, or parts that stay under a size.',
    fields: [
      {
        name: 'mode',
        label: 'Split by',
        kind: 'segmented',
        default: 'pages',
        options: [
          { value: 'pages', label: 'Pages' },
          { value: 'ranges', label: 'Ranges' },
          { value: 'fixed', label: 'Fixed' },
          { value: 'size', label: 'Size' },
        ],
      },
      {
        name: 'pages',
        label: 'Pages',
        kind: 'text',
        showWhen: { field: 'mode', equals: ['pages'] },
        help: 'For example 1-3,5,8- — leave blank for every page as its own file.',
      },
      {
        name: 'ranges',
        label: 'Ranges',
        kind: 'text',
        showWhen: { field: 'mode', equals: ['ranges'] },
        help: 'One document per range. For example 1-6,10-12.',
      },
      {
        name: 'every',
        label: 'Pages per file',
        kind: 'number',
        min: 1,
        max: 5000,
        default: 1,
        showWhen: { field: 'mode', equals: ['fixed'] },
      },
      {
        name: 'maxMb',
        label: 'Largest file (MB)',
        kind: 'number',
        min: 0.05,
        max: 500,
        step: 0.05,
        default: 5,
        showWhen: { field: 'mode', equals: ['size'] },
        help: 'Parts are packed to stay under this. A single page larger than it goes out on its own.',
      },
      {
        name: 'mergeAll',
        label: 'Put all the parts in one file',
        kind: 'toggle',
        default: false,
        showWhen: { field: 'mode', equals: ['ranges', 'fixed', 'size'] },
      },
    ],
  },

  async run({ inputs, outDir, params, onProgress }) {
    const taken = new Set<string>()
    const outputs: OutputFile[] = []

    for (const [index, input] of inputs.entries()) {
      const source = await loadPdf(input.path)
      const pageCount = source.getPageCount()
      let groups: Group[]

      if (params.mode === 'ranges') {
        groups = parseSplitRanges(params.ranges, pageCount).map((range) => ({
          pages: sequence(range.from, range.to),
          suffix: range.from === range.to ? `-${range.from}` : `-${range.from}-${range.to}`,
        }))
      } else if (params.mode === 'fixed') {
        groups = []
        for (let start = 1; start <= pageCount; start += params.every) {
          groups.push({
            pages: sequence(start, Math.min(start + params.every - 1, pageCount)),
            suffix: `-part-${groups.length + 1}`,
          })
        }
      } else if (params.mode === 'size') {
        groups = (await packBySize(source, params.maxMb * 1024 * 1024)).map((pages, at) => ({
          pages,
          suffix: `-part-${at + 1}`,
        }))
      } else if (params.pages && params.pages.trim() !== '') {
        groups = [{ pages: parsePageRanges(params.pages, pageCount), suffix: '-pages' }]
      } else {
        groups = sequence(1, pageCount).map((page) => ({ pages: [page], suffix: `-page-${page}` }))
      }

      if (params.mergeAll && groups.length > 1) {
        groups = [{ pages: groups.flatMap((group) => group.pages), suffix: '-split' }]
      }

      for (const group of groups) {
        const part = await PDFDocument.create()
        const copied = await part.copyPages(source, toIndices(group.pages))
        for (const page of copied) part.addPage(page)

        const name = uniqueName(taken, deriveName(input.name, { ext: 'pdf', suffix: group.suffix }))
        const dest = join(outDir, name)
        await writeFile(dest, await part.save())
        outputs.push({ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size })
      }

      onProgress?.((index + 1) / inputs.length)
    }

    return outputs
  },
}
