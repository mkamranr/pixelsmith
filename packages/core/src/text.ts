/**
 * Escape text for inclusion in an SVG document.
 *
 * Watermark and meme captions are user input rendered through librsvg. Without
 * escaping, a caption containing `<` produces either a broken document or an
 * element we never intended to draw — so every caption goes through here.
 */
export function escapeXml(text: string): string {
  return stripControlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Drop characters that are not legal in XML. librsvg rejects the whole document
 * if one appears, which would turn a stray byte in a filename or caption into a
 * failed job.
 */
export function stripControlChars(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const legal = code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)
    if (legal) out += ch
  }
  return out
}

/**
 * Font stack for rendered text. DejaVu is what the container image installs;
 * the rest are fallbacks for a bare-metal host or a developer machine.
 */
export const FONT_STACK = "'DejaVu Sans', 'Liberation Sans', Helvetica, Arial, sans-serif"

/**
 * Wrap text to a pixel width using an average-glyph estimate.
 *
 * Real metrics would need the font loaded and measured; for captions this is
 * close enough, and erring toward narrow lines is safe — a caption that wraps a
 * word early still reads correctly, one that overflows the canvas does not.
 */
/**
 * Letters that are written right to left: Hebrew, Arabic and its neighbours,
 * plus the presentation forms a badly-made PDF sometimes carries.
 */
const RTL_LETTERS =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g

/** Letters written left to right, for comparison. Latin, Greek, Cyrillic. */
const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g

/**
 * Which way a line runs.
 *
 * Decided by which script most of the letters are in rather than by the first
 * one found: a figure or a product name inside an Arabic sentence does not make
 * the sentence English, and one Arabic word in an English sentence does not
 * flip it.
 *
 * This matters more than it looks. The base direction of a line decides where
 * neutral characters — a full stop, a comma, a bracket — end up, so getting it
 * wrong puts the full stop at the wrong end of every Arabic sentence.
 */
export function isRightToLeft(text: string): boolean {
  const rtl = (text.match(RTL_LETTERS) ?? []).length
  if (rtl === 0) return false
  const ltr = (text.match(LTR_LETTERS) ?? []).length
  return rtl > ltr
}

export function wrapText(text: string, maxWidthPx: number, fontSize: number): string[] {
  const perChar = fontSize * 0.58
  const maxChars = Math.max(8, Math.floor(maxWidthPx / perChar))
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? line + ' ' + word : word
    if (candidate.length <= maxChars) {
      line = candidate
    } else {
      if (line) lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}
