import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { writeTextDocument } from '../src/pdf-document.js'
import { preparePdfText } from '../src/pdf-draw-text.js'
import { renderPdfPage } from '../src/pdf-render.js'
import { isRightToLeft } from '../src/text.js'

const ARABIC = 'أعدّ لجنة التوجيه التقني.'
const ENGLISH = 'Prepared for the technical steering committee.'

describe('telling which way a line runs', () => {
  it('knows Arabic runs right to left', () => {
    expect(isRightToLeft(ARABIC)).toBe(true)
  })

  it('knows Hebrew does too', () => {
    expect(isRightToLeft('ועדת ההיגוי הטכנית')).toBe(true)
  })

  it('knows English does not', () => {
    expect(isRightToLeft(ENGLISH)).toBe(false)
  })

  it('goes by which script the words are in, not by a stray character', () => {
    // A figure or a product name inside an Arabic sentence does not make the
    // sentence English, and an Arabic word in an English one does not flip it.
    expect(isRightToLeft('تبلغ النفقات 4.2 مليون درهم.')).toBe(true)
    expect(isRightToLeft('The budget is 4.5 million (ميزانية).')).toBe(false)
  })

  it('says nothing about text with no letters at all', () => {
    expect(isRightToLeft('4.2 — 5.1')).toBe(false)
    expect(isRightToLeft('')).toBe(false)
  })
})

describe('laying out a right-to-left line', () => {
  /**
   * The base direction of the paragraph decides where a neutral character — a
   * full stop, a comma, a bracket — ends up. Rendering Arabic with a
   * left-to-right base puts the full stop at the wrong end of the line, which
   * is what a translated document looked like.
   */
  const inkOf = async (text: string) => {
    const doc = await PDFDocument.create()
    const mark = await preparePdfText(doc, { text, size: 24 })
    return mark
  }

  it('produces a mark for Arabic at all', async () => {
    const mark = await inkOf(ARABIC)

    expect(mark.width).toBeGreaterThan(0)
    expect(mark.selectable).toBe(false)
  })

  /**
   * Rendered pixels, not measurements.
   *
   * A line's ink is the same width whichever order the glyphs are placed in —
   * the same glyphs with the same advances — so width and height cannot detect
   * a paragraph laid out backwards. I found that by removing the base direction
   * and watching a width-based test carry on passing.
   */
  const pixelsOf = async (text: string) => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([620, 90])
    const mark = await preparePdfText(doc, { text, size: 22 })
    mark.draw(page, { x: 20, y: 35 })

    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const path = join(tmpdir(), `bidi-${Math.random().toString(36).slice(2)}.pdf`)
    await writeFile(path, await doc.save())
    return renderPdfPage(path, 1, { scale: 1 })
  }

  const differenceBetween = async (one: Buffer, two: Buffer) => {
    const diff = await sharp(one).composite([{ input: two, blend: 'difference' }]).png().toBuffer()
    return (await sharp(diff).stats()).channels[0]!.mean
  }

  it('is laid out right to left by the text engine, without being told', async () => {
    /**
     * An assumption this depends on rather than something it does.
     *
     * I set an explicit right-to-left base direction here and then measured
     * whether it mattered: the render is pixel-identical with it, without it,
     * and against the same line forced right-to-left by an embedded mark. So
     * librsvg resolves the direction from the text itself, the attribute was
     * removed, and this is here to notice if that ever stops being true.
     */
    const RLM = '\u200f'
    const startsLatin = 'Pixelsmith تبلغ النفقات 4.2 مليون درهم مقابل ميزانية.'

    const plain = await pixelsOf(startsLatin)
    const forced = await pixelsOf(RLM + startsLatin)

    expect(await differenceBetween(plain, forced)).toBeLessThan(0.2)
  })
})

describe('a document in a right-to-left language', () => {
  const pageOf = async (body: string) => {
    const bytes = await writeTextDocument({ title: 'عنوان', body })
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const path = join(tmpdir(), `rtl-${Math.random().toString(36).slice(2)}.pdf`)
    await writeFile(path, bytes)
    return renderPdfPage(path, 1, { scale: 1 })
  }

  /** Which half of the page the ink sits in. */
  const weight = async (png: Buffer) => {
    const { width = 595, height = 842 } = await sharp(png).metadata()
    const half = Math.floor(width / 2)
    const darkness = async (left: number) => {
      const strip = await sharp(png)
        .extract({ left, top: 0, width: half, height })
        .greyscale()
        .toBuffer()
      const { channels } = await sharp(strip).stats()
      // Lower mean = more ink.
      return 255 - channels[0]!.mean
    }
    return { left: await darkness(0), right: await darkness(half) }
  }

  it('sets Arabic against the right margin', async () => {
    // Arabic left-aligned reads as though the page were the wrong way round.
    const ink = await weight(await pageOf('تبلغ النفقات 4.2 مليون درهم مقابل ميزانية تبلغ 4.5 مليون.'))

    expect(ink.right).toBeGreaterThan(ink.left)
  })

  it('leaves English against the left margin', async () => {
    const ink = await weight(await pageOf(ENGLISH))

    expect(ink.left).toBeGreaterThan(ink.right)
  })

  it('aligns each paragraph by its own language', async () => {
    /**
     * A translated document often carries both — the source beside the
     * translation — and each should sit where its own readers expect.
     *
     * The bands are found by looking for rows that have ink rather than by
     * assuming where they land: the title's height depends on the font, and a
     * test that guesses the offset fails for reasons of its own.
     */
    const png = await pageOf(`${ENGLISH}\n\nتبلغ النفقات 4.2 مليون درهم.`)
    const { width = 595, height = 842 } = await sharp(png).metadata()
    const half = Math.floor(width / 2)
    const grey = await sharp(png).greyscale().raw().toBuffer()

    /** Rows holding ink, grouped into the blocks they belong to. */
    const bands: { from: number; to: number }[] = []
    let open: number | null = null
    for (let y = 0; y < height; y += 1) {
      let dark = 0
      for (let x = 0; x < width; x += 1) if (grey[y * width + x]! < 200) dark += 1
      if (dark > 0 && open === null) open = y
      if (dark === 0 && open !== null) {
        if (y - open >= 4) bands.push({ from: open, to: y })
        open = null
      }
    }

    // Title, then the English paragraph, then the Arabic one.
    expect(bands.length, `bands found: ${JSON.stringify(bands)}`).toBeGreaterThanOrEqual(3)

    const sideOf = async (band: { from: number; to: number }) => {
      const box = { top: band.from, height: Math.max(1, band.to - band.from) }
      const ink = async (left: number) => {
        const strip = await sharp(png).extract({ left, width: half, ...box }).greyscale().toBuffer()
        return 255 - (await sharp(strip).stats()).channels[0]!.mean
      }
      return { left: await ink(0), right: await ink(half) }
    }

    const english = await sideOf(bands[1]!)
    const arabic = await sideOf(bands[bands.length - 1]!)

    expect(english.left).toBeGreaterThan(english.right)
    expect(arabic.right).toBeGreaterThan(arabic.left)
  })
})
