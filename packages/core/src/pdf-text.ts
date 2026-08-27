import { openDocument } from './pdf-render.js'

/**
 * How far apart two baselines can be, in points, and still count as one line.
 * Superscripts and slightly uneven typesetting sit within a point or two of
 * their neighbours; a new line is always further than that.
 */
const LINE_TOLERANCE = 2

/** A gap wider than this, in points, reads as a word space. */
const WORD_GAP = 1

/**
 * A gap wider than this, in points, reads as a column boundary rather than a
 * space. Words in a line of prose sit three or four points apart at ordinary
 * sizes; the columns of a table are separated by far more.
 */
const CELL_GAP = 8

export interface TextPiece {
  x: number
  y: number
  width: number
  /** Roughly the type size, which is what a glyph's height is measured from. */
  height: number
  str: string
}

export interface PageText {
  /** The page's own size in points, with any rotation already applied. */
  width: number
  height: number
  lines: TextPiece[][]
}

/** Where a piece's characters sit within its line's assembled string. */
export interface PieceSpan {
  piece: TextPiece
  start: number
  end: number
}

/**
 * Every page as lines of text pieces, ordered top to bottom and left to right.
 *
 * pdf.js hands back text in content-stream order, which is the order the
 * generator happened to write it — often not reading order. Pieces are
 * therefore regrouped by baseline and sorted, because a diff or a spreadsheet
 * built from stream order is nonsense.
 *
 * Multi-column page layouts are the known limit: two columns of prose share
 * baselines, so their lines interleave. Telling those apart from a table needs
 * layout analysis this does not attempt.
 */
export async function pdfPageText(path: string): Promise<PageText[]> {
  const doc = await openDocument(path)

  try {
    const pages: PageText[] = []

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)

      try {
        const content = await page.getTextContent()
        const viewport = page.getViewport({ scale: 1 })
        const lines: TextPiece[][] = []

        for (const item of content.items) {
          // Marked-content boundaries appear in the same list and carry no text.
          if (!('str' in item) || item.str === '') continue
          /**
           * pdf.js inserts a synthetic whitespace item spanning each gap it
           * finds, whose width is the whole gap. Kept as a piece it would erase
           * the very gap it describes — the cursor would land exactly on the
           * next piece and every column boundary would measure zero. The real
           * pieces carry accurate widths, so the gap is better read from them.
           */
          if (item.str.trim() === '') continue
          const transform = item.transform as number[]
          const piece: TextPiece = {
            x: transform[4]!,
            y: transform[5]!,
            width: item.width ?? 0,
            height: item.height ?? 0,
            str: item.str,
          }

          const line = lines.find((candidate) => Math.abs(candidate[0]!.y - piece.y) <= LINE_TOLERANCE)
          if (line) line.push(piece)
          else lines.push([piece])
        }

        lines.sort((a, b) => b[0]!.y - a[0]!.y)
        for (const line of lines) line.sort((a, b) => a.x - b.x)
        pages.push({ width: viewport.width, height: viewport.height, lines })
      } finally {
        page.cleanup()
      }
    }

    return pages
  } finally {
    await doc.destroy()
  }
}

/**
 * Join pieces into one string, inserting a space only where there is a gap, and
 * record where each piece's characters ended up. The offsets are what lets a
 * match found in the string be turned back into a box on the page.
 */
export function joinWithSpans(pieces: TextPiece[]): { text: string; spans: PieceSpan[] } {
  let text = ''
  let cursor: number | undefined
  const spans: PieceSpan[] = []

  for (const piece of pieces) {
    const gapped = cursor !== undefined && piece.x - cursor > WORD_GAP
    // Do not manufacture a space next to one the document already has.
    if (gapped && !text.endsWith(' ') && !piece.str.startsWith(' ')) text += ' '
    const start = text.length
    text += piece.str
    spans.push({ piece, start, end: text.length })
    cursor = piece.x + piece.width
  }

  return { text, spans }
}

/** Join pieces into one string, inserting a space only where there is a gap. */
function joinPieces(pieces: TextPiece[]): string {
  return joinWithSpans(pieces).text
}

/** The text of each page, one string per page, lines separated by newlines. */
export async function extractPdfText(path: string): Promise<string[]> {
  const pages = await pdfPageText(path)
  return pages.map((page) => page.lines.map(joinPieces).join('\n'))
}

/**
 * Each page as rows of cells, splitting a line wherever a table-sized gap
 * appears. A page of prose yields one cell per row, which is the right answer
 * for prose: there are no columns to find.
 */
export async function extractPdfRows(
  path: string,
  options: { cellGap?: number } = {},
): Promise<string[][][]> {
  const cellGap = options.cellGap ?? CELL_GAP
  const pages = await pdfPageText(path)

  return pages.map((page) =>
    page.lines.map((line) => {
      const cells: TextPiece[][] = []
      let cursor: number | undefined

      for (const piece of line) {
        if (cursor === undefined || piece.x - cursor <= cellGap) {
          if (cells.length === 0) cells.push([])
          cells[cells.length - 1]!.push(piece)
        } else {
          cells.push([piece])
        }
        cursor = piece.x + piece.width
      }

      return cells.map(joinPieces)
    }),
  )
}
