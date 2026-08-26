/**
 * The sticker catalogue: reusable vector marks that can be stamped onto an
 * image, scaled and coloured.
 *
 * These are annotation marks — arrows, callouts, status symbols, redaction
 * blocks — rather than decorative art, because that is what an internal tool
 * is actually used for: pointing at something in a screenshot, flagging a
 * problem, covering a detail before a document is shared.
 *
 * Every sticker is a single path in a 100x100 box, drawn with the even-odd fill
 * rule so an interior cut-out (the bar of a warning sign, the hole in a ring)
 * is just another subpath. Defined once here and served to the browser by the
 * API, so the preview and the final render cannot use different geometry.
 */

export interface StickerCategory {
  id: string
  label: string
}

export interface Sticker {
  id: string
  label: string
  category: string
  /** SVG viewBox the path is drawn in. */
  viewBox: string
  /** Path data, using the even-odd fill rule. */
  path: string
}

export const STICKER_CATEGORIES: StickerCategory[] = [
  { id: 'arrows', label: 'Arrows' },
  { id: 'marks', label: 'Marks' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'redact', label: 'Redaction' },
]

const BOX = '0 0 100 100'

export const STICKERS: Sticker[] = [
  // ---- arrows: for pointing at a detail ----
  { id: 'arrow-right', label: 'Arrow right', category: 'arrows', viewBox: BOX,
    path: 'M8 40 H60 V18 L96 50 L60 82 V60 H8 Z' },
  { id: 'arrow-left', label: 'Arrow left', category: 'arrows', viewBox: BOX,
    path: 'M92 40 H40 V18 L4 50 L40 82 V60 H92 Z' },
  { id: 'arrow-up', label: 'Arrow up', category: 'arrows', viewBox: BOX,
    path: 'M40 92 V40 H18 L50 4 L82 40 H60 V92 Z' },
  { id: 'arrow-down', label: 'Arrow down', category: 'arrows', viewBox: BOX,
    path: 'M40 8 V60 H18 L50 96 L82 60 H60 V8 Z' },
  { id: 'arrow-corner', label: 'Bent arrow', category: 'arrows', viewBox: BOX,
    path: 'M14 88 V34 H36 L18 6 L0 34 H8 V96 H92 V78 H14 Z' },
  { id: 'chevrons', label: 'Chevrons', category: 'arrows', viewBox: BOX,
    path: 'M12 16 L46 50 L12 84 L2 74 L26 50 L2 26 Z M56 16 L90 50 L56 84 L46 74 L70 50 L46 26 Z' },

  // ---- marks: status and emphasis ----
  { id: 'tick', label: 'Tick', category: 'marks', viewBox: BOX,
    path: 'M38 88 L4 54 L18 40 L38 60 L82 16 L96 30 Z' },
  { id: 'cross', label: 'Cross', category: 'marks', viewBox: BOX,
    path: 'M20 8 L50 38 L80 8 L92 20 L62 50 L92 80 L80 92 L50 62 L20 92 L8 80 L38 50 L8 20 Z' },
  { id: 'warning', label: 'Warning', category: 'marks', viewBox: BOX,
    path: 'M50 4 L98 92 H2 Z M45 34 H55 V64 H45 Z M45 72 H55 V84 H45 Z' },
  { id: 'star', label: 'Star', category: 'marks', viewBox: BOX,
    path: 'M50 4 L62 37 H97 L69 58 L79 94 L50 72 L21 94 L31 58 L3 37 H38 Z' },
  { id: 'exclamation', label: 'Exclamation', category: 'marks', viewBox: BOX,
    path: 'M50 2 A48 48 0 1 0 50 98 A48 48 0 1 0 50 2 Z M44 22 H56 V58 H44 Z M44 66 H56 V78 H44 Z' },
  { id: 'ring', label: 'Ring', category: 'marks', viewBox: BOX,
    path: 'M50 2 A48 48 0 1 0 50 98 A48 48 0 1 0 50 2 Z M50 16 A34 34 0 1 1 50 84 A34 34 0 1 1 50 16 Z' },

  // ---- callouts: for labelling ----
  { id: 'bubble', label: 'Speech bubble', category: 'callouts', viewBox: BOX,
    path: 'M10 10 H90 V70 H44 L22 92 V70 H10 Z' },
  { id: 'bubble-round', label: 'Round bubble', category: 'callouts', viewBox: BOX,
    path: 'M50 8 C22 8 6 24 6 42 C6 60 22 74 44 74 L40 96 L64 72 C84 68 94 56 94 42 C94 24 78 8 50 8 Z' },
  { id: 'tag', label: 'Tag', category: 'callouts', viewBox: BOX,
    path: 'M6 30 H70 L94 50 L70 70 H6 Z M18 44 A6 6 0 1 0 18 56 A6 6 0 1 0 18 44 Z' },
  { id: 'pin', label: 'Map pin', category: 'callouts', viewBox: BOX,
    path: 'M50 4 C31 4 16 19 16 38 C16 62 50 96 50 96 C50 96 84 62 84 38 C84 19 69 4 50 4 Z M50 24 A14 14 0 1 1 50 52 A14 14 0 1 1 50 24 Z' },
  { id: 'flag', label: 'Flag', category: 'callouts', viewBox: BOX,
    path: 'M18 4 H26 V96 H18 Z M30 8 H88 L74 30 L88 52 H30 Z' },
  { id: 'bracket', label: 'Brackets', category: 'callouts', viewBox: BOX,
    path: 'M8 8 H38 V18 H18 V82 H38 V92 H8 Z M92 8 H62 V18 H82 V82 H62 V92 H92 Z' },

  // ---- redaction: for covering a detail before sharing ----
  { id: 'block', label: 'Solid block', category: 'redact', viewBox: BOX,
    path: 'M4 26 H96 V74 H4 Z' },
  { id: 'bar', label: 'Thin bar', category: 'redact', viewBox: BOX,
    path: 'M2 40 H98 V60 H2 Z' },
  { id: 'lock', label: 'Lock', category: 'redact', viewBox: BOX,
    path: 'M20 44 H80 V94 H20 Z M34 44 V28 A16 16 0 0 1 66 28 V44 H54 V28 A4 4 0 0 0 46 28 V44 Z' },
  { id: 'eye-off', label: 'Hidden', category: 'redact', viewBox: BOX,
    path: 'M6 50 C22 26 78 26 94 50 C78 74 22 74 6 50 Z M50 36 A14 14 0 1 1 50 64 A14 14 0 1 1 50 36 Z M14 6 L94 86 L86 94 L6 14 Z' },
  { id: 'stamp', label: 'Stamp', category: 'redact', viewBox: BOX,
    path: 'M8 78 H92 V94 H8 Z M18 60 H82 V72 H18 Z M36 56 V26 A14 14 0 0 1 64 26 V56 H52 V26 A2 2 0 0 0 48 26 V56 Z' },
]

/** Ids the recipe schema accepts, so an unknown sticker is refused up front. */
export const STICKER_IDS = STICKERS.map((s) => s.id) as [string, ...string[]]

export function stickerById(id: string): Sticker | undefined {
  return STICKERS.find((s) => s.id === id)
}
