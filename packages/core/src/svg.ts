import { UnsafeSvgError } from './errors.js'

/**
 * SVG is the one input format that is a program rather than a picture. We
 * *reject* hostile files instead of rewriting them: parse-and-rebuild risks
 * mangling valid artwork and quietly introducing sanitiser bugs, while a clear
 * refusal tells the user exactly what was wrong. False positives are acceptable
 * here — wrongly refusing an exotic SVG is cheaper than a file read on the host.
 */
export type SvgRisk = 'doctype' | 'script' | 'event-handler' | 'external-reference' | 'foreign-object'

const NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
}

/**
 * Decode character references before matching, so `&#106;avascript:` cannot
 * smuggle a scheme past a plain string search. Decoding can only reveal more
 * markup than the raw text showed, never less, which is the direction we want.
 */
function decodeRefs(input: string): string {
  return input.replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-z0-9#]+);/gi, (whole, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    const key = String(name).toLowerCase()
    return NAMED[key] ?? whole
  })
}

/** Any URI scheme other than `data:` means the renderer might leave the process. */
const SCHEME_IN_REF = /\b(?:href|src)\s*=\s*["']?\s*([a-z][a-z0-9+.\-]*)\s*:/gi
const SCHEME_IN_URL = /url\(\s*["']?\s*([a-z][a-z0-9+.\-]*)\s*:/gi
const PROTOCOL_RELATIVE = /\b(?:href|src)\s*=\s*["']?\s*\/\//i

export function svgRisks(source: string): SvgRisk[] {
  const text = decodeRefs(source)
  const risks = new Set<SvgRisk>()

  if (/<!\s*doctype/i.test(text) || /<!\s*entity/i.test(text)) risks.add('doctype')
  if (/<\s*\/?\s*script[\s>/]/i.test(text)) risks.add('script')
  if (/<\s*\/?\s*foreignobject/i.test(text)) risks.add('foreign-object')
  if (/\son[a-z]+\s*=/i.test(text)) risks.add('event-handler')

  for (const re of [SCHEME_IN_REF, SCHEME_IN_URL]) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      if (m[1] && m[1].toLowerCase() !== 'data') risks.add('external-reference')
    }
  }
  if (PROTOCOL_RELATIVE.test(text)) risks.add('external-reference')

  return [...risks]
}

export function assertSvgSafe(source: string): void {
  const risks = svgRisks(source)
  if (risks.length > 0) throw new UnsafeSvgError(risks)
}
