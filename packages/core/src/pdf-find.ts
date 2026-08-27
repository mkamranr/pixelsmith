import { joinWithSpans, pdfPageText, type PageText, type PieceSpan } from './pdf-text.js'

/** An area of a page, as fractions measured from its top left. */
export interface TextBox {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export type RedactPattern = 'email' | 'phone' | 'card'

export interface FindTextOptions {
  /** Phrases to look for, matched without regard to case. */
  terms?: string[]
  /** Kinds of sensitive value to sweep for. */
  patterns?: RedactPattern[]
  /** Extra margin around each match, as a fraction of its height. */
  padding?: number
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * A run that might be a telephone or card number. Deliberately loose: what it
 * actually is gets decided afterwards, by counting digits and — for a card —
 * by the Luhn check.
 */
const NUMBER_RUN = /[+(]?\d[\d\s()+.\-]{4,}\d/g

const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15
const MIN_CARD_DIGITS = 13
const MAX_CARD_DIGITS = 19

/** How far below the baseline a descender reaches, as a fraction of the size. */
const DESCENDER = 0.22

interface Range {
  start: number
  end: number
}

/**
 * The check digit every card number carries.
 *
 * Used instead of counting to sixteen because a bare digit count marks invoice
 * references and order numbers as card numbers, and a redaction tool that cries
 * wolf is a redaction tool nobody leaves switched on.
 */
export function passesLuhn(digits: string): boolean {
  if (digits.length === 0) return false
  let sum = 0
  let double = false

  for (let at = digits.length - 1; at >= 0; at--) {
    let value = digits.charCodeAt(at) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }

  return sum % 10 === 0
}

function literalRanges(text: string, term: string): Range[] {
  const needle = term.trim().toLowerCase()
  if (needle === '') return []

  const haystack = text.toLowerCase()
  const found: Range[] = []
  let at = haystack.indexOf(needle)

  while (at !== -1) {
    found.push({ start: at, end: at + needle.length })
    at = haystack.indexOf(needle, at + needle.length)
  }

  return found
}

function patternRanges(text: string, pattern: RedactPattern): Range[] {
  const found: Range[] = []

  if (pattern === 'email') {
    for (const match of text.matchAll(EMAIL)) {
      found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
    }
    return found
  }

  for (const match of text.matchAll(NUMBER_RUN)) {
    const run = match[0]
    const digits = run.replace(/\D/g, '')
    const enough =
      pattern === 'card'
        ? digits.length >= MIN_CARD_DIGITS && digits.length <= MAX_CARD_DIGITS && passesLuhn(digits)
        : digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS
    if (!enough) continue

    // The run may have swept up a trailing bracket or dash.
    const trimmed = run.replace(/[\s.()+-]+$/, '')
    found.push({ start: match.index ?? 0, end: (match.index ?? 0) + trimmed.length })
  }

  return found
}

/**
 * Turn a match in a line's assembled text back into an area of the page.
 *
 * A match rarely lines up with the runs a generator happened to emit, so the
 * first and last run are entered part way: the position within a run is taken
 * proportionally across its characters. That is an approximation, and it errs
 * outwards — for redaction, covering a little too much is the safe direction.
 */
function boxFor(
  spans: PieceSpan[],
  range: Range,
  page: PageText,
  padding: number,
): Omit<TextBox, 'page'> | null {
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity

  for (const span of spans) {
    if (span.end <= range.start || span.start >= range.end) continue

    const piece = span.piece
    const characters = span.end - span.start
    if (characters <= 0) continue

    const perCharacter = piece.width / characters
    const from = Math.max(0, range.start - span.start)
    const to = Math.min(characters, range.end - span.start)

    left = Math.min(left, piece.x + from * perCharacter)
    right = Math.max(right, piece.x + to * perCharacter)
    // PDF measures up from the bottom of the page; a box is easier to reason
    // about from the top, which is also how the browser marks them.
    top = Math.min(top, page.height - (piece.y + piece.height))
    bottom = Math.max(bottom, page.height - (piece.y - piece.height * DESCENDER))
  }

  if (left === Infinity) return null

  const grow = (bottom - top) * padding
  const x = Math.max(0, left - grow)
  const y = Math.max(0, top - grow)
  const width = Math.min(page.width, right + grow) - x
  const height = Math.min(page.height, bottom + grow) - y
  if (width <= 0 || height <= 0) return null

  return {
    x: x / page.width,
    y: y / page.height,
    width: width / page.width,
    height: height / page.height,
  }
}

/**
 * Find the areas of a document holding the given phrases or kinds of value.
 *
 * Done here rather than in the browser because the coordinates are exact — they
 * come from the document rather than from a rendered picture of it — and because
 * it then works with no script at all.
 */
export async function findTextBoxes(
  path: string,
  options: FindTextOptions,
): Promise<TextBox[]> {
  const terms = (options.terms ?? []).filter((term) => term.trim() !== '')
  const patterns = options.patterns ?? []
  if (terms.length === 0 && patterns.length === 0) return []

  const padding = options.padding ?? 0
  const pages = await pdfPageText(path)
  const boxes: TextBox[] = []
  const seen = new Set<string>()

  for (const [index, page] of pages.entries()) {
    for (const line of page.lines) {
      const { text, spans } = joinWithSpans(line)
      const ranges: Range[] = []

      for (const term of terms) ranges.push(...literalRanges(text, term))
      for (const pattern of patterns) ranges.push(...patternRanges(text, pattern))

      for (const range of ranges) {
        const box = boxFor(spans, range, page, padding)
        if (!box) continue

        const found: TextBox = { page: index + 1, ...box }
        // Two criteria can land on the same words; one box is enough.
        const key = [
          found.page,
          found.x.toFixed(4),
          found.y.toFixed(4),
          found.width.toFixed(4),
          found.height.toFixed(4),
        ].join(':')
        if (seen.has(key)) continue

        seen.add(key)
        boxes.push(found)
      }
    }
  }

  return boxes
}
