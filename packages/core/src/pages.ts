import { BadInputError } from './errors.js'

/**
 * How many pages one selection may name. A selection is expanded into a real
 * list, so `1-` on a huge document would otherwise build an enormous array
 * before any tool got a chance to refuse it.
 */
const MAX_SELECTED = 5000

const SINGLE = /^(\d+)$/
const RANGE = /^(\d*)-(\d*)$/

/**
 * Parse a page selection such as `1-3,5,8-` into an explicit page list.
 *
 * Two deliberate properties, because the same syntax is used both to *choose*
 * pages and to *reorder* them:
 * - order is preserved exactly as written, so `5,1,3` means that sequence;
 * - repeats are kept, so a page can be duplicated on purpose.
 *
 * Pages are numbered from one, the way they are described to a person.
 */
export function parsePageRanges(spec: string | undefined, pageCount: number): number[] {
  const trimmed = (spec ?? '').trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'all') {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }

  const pages: number[] = []

  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim().replace(/\s+/g, '')
    if (part === '') continue

    const single = SINGLE.exec(part)
    if (single) {
      pages.push(assertInRange(Number(single[1]), pageCount, part))
      continue
    }

    const range = RANGE.exec(part)
    if (range) {
      // An omitted bound means "from the start" or "to the end".
      const from = range[1] === '' ? 1 : assertInRange(Number(range[1]), pageCount, part)
      const to = range[2] === '' ? pageCount : assertInRange(Number(range[2]), pageCount, part)
      const step = from <= to ? 1 : -1
      for (let page = from; step > 0 ? page <= to : page >= to; page += step) {
        pages.push(page)
      }
      continue
    }

    throw new BadInputError(`"${rawPart.trim()}" is not a page or a range — use something like 1-3,5,8-`)
  }

  if (pages.length === 0) throw new BadInputError('no pages were selected')
  if (pages.length > MAX_SELECTED) {
    throw new BadInputError(`that selection names ${pages.length} pages, more than the ${MAX_SELECTED} allowed at once`)
  }

  return pages
}

function assertInRange(page: number, pageCount: number, part: string): number {
  if (!Number.isInteger(page) || page < 1) {
    throw new BadInputError(`"${part}" is not a valid page — pages are numbered from 1`)
  }
  if (page > pageCount) {
    throw new BadInputError(`"${part}" is past the end of a ${pageCount}-page document`)
  }
  return page
}

/** Convert a 1-based selection to the 0-based indices pdf-lib works in. */
export function toIndices(pages: number[]): number[] {
  return pages.map((page) => page - 1)
}
