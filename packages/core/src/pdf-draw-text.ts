import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { degrees, PDFDocument, PDFPage, rgb, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { escapeXml, FONT_STACK } from './text.js'

/** Rendered marks are drawn large and scaled down, so they stay crisp in print. */
const SUPERSAMPLE = 3

/** Canvas height and baseline position, as multiples of the type size. */
const HEIGHT_RATIO = 1.35
const BASELINE_RATIO = 1.0

export interface PdfTextMark {
  /** Width and height in points. */
  width: number
  height: number
  /** Whether this arrived as real text. False for a rendered image. */
  selectable: boolean
  /** Draw the mark with its baseline starting at (x, y), as drawText would. */
  draw(page: PDFPage, at: { x: number; y: number; opacity?: number; rotate?: number }): void
}

export interface PdfTextSpec {
  text: string
  size: number
  /** Components in 0..1, as pdf-lib expects. */
  colour?: { r: number; g: number; b: number }
  bold?: boolean
  /**
   * A registered font family to set the text in — a handwriting face for a
   * signature, say. Such a face is not one of the PDF standard fonts, so text
   * asking for one is always drawn rather than kept selectable.
   */
  family?: string
}

/**
 * Prepare a piece of text for drawing onto a PDF page, whatever script it is in.
 *
 * pdf-lib's standard fonts are WinAnsi-encoded: they throw outright on Arabic,
 * Chinese or anything else outside Latin-1. Embedding a font with the glyphs
 * would not be enough either, because drawText maps characters to glyphs one at
 * a time with no shaping — Arabic letters would stand apart instead of joining,
 * and run in the wrong direction.
 *
 * So text the standard fonts can encode is drawn as text, which keeps it
 * selectable and the file small. Anything else is laid out by librsvg, which
 * shapes and orders it properly, and embedded as an image. The trade is stated
 * on the mark: `selectable` says which happened.
 */
/** One line of text in a registered family, on a transparent canvas. */
function drawWithFace(
  text: string,
  family: string,
  fontPx: number,
  width: number,
  height: number,
  baseline: number,
  fill: string,
): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  // Quoted: family names have spaces in them, and an unquoted one is parsed as
  // a list of keywords and dropped.
  ctx.font = `${fontPx}px "${family}"`
  ctx.fillStyle = fill
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, 0, baseline)
  return canvas.toBuffer('image/png')
}

export async function preparePdfText(doc: PDFDocument, spec: PdfTextSpec): Promise<PdfTextMark> {
  const colour = spec.colour ?? { r: 0, g: 0, b: 0 }
  const font = await doc.embedFont(spec.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)

  // Measuring throws on exactly the text drawing would throw on, which makes it
  // a reliable and cheap way to ask "can the standard font handle this?".
  // Skipped entirely when a particular family was asked for: Helvetica can
  // encode a Latin name perfectly well, and using it anyway would quietly
  // ignore the request.
  let textWidth: number | undefined
  const wantsFace = spec.family !== undefined && GlobalFonts.has(spec.family)
  try {
    textWidth = wantsFace ? undefined : font.widthOfTextAtSize(spec.text, spec.size)
  } catch {
    textWidth = undefined
  }

  if (textWidth !== undefined) {
    return {
      width: textWidth,
      height: font.heightAtSize(spec.size),
      selectable: true,
      draw(page, at) {
        page.drawText(spec.text, {
          x: at.x,
          y: at.y,
          size: spec.size,
          font,
          color: rgb(colour.r, colour.g, colour.b),
          ...(at.opacity !== undefined ? { opacity: at.opacity } : {}),
          ...(at.rotate !== undefined ? { rotate: degrees(at.rotate) } : {}),
        })
      },
    }
  }

  const fontPx = spec.size * SUPERSAMPLE
  // Generous canvas: the text is trimmed to its ink afterwards, so being too
  // wide costs nothing, while being too narrow would clip the line.
  const canvasWidth = Math.ceil(Math.max(fontPx * 2, spec.text.length * fontPx * 1.6))
  const canvasHeight = Math.ceil(fontPx * HEIGHT_RATIO)
  const baselinePx = fontPx * BASELINE_RATIO
  const fill = `rgb(${Math.round(colour.r * 255)},${Math.round(colour.g * 255)},${Math.round(colour.b * 255)})`

  /**
   * Two ways to get pixels, chosen by what was asked for rather than by taste.
   *
   * A named family goes through the canvas, because the face is registered in
   * this process and fontconfig — which is what librsvg consults — may not know
   * it and would silently substitute something else.
   *
   * Everything else goes through librsvg, which shapes and orders complex
   * scripts properly. That is the whole reason this function exists.
   */
  /**
   * No base direction is set here, and that is deliberate.
   *
   * I added `direction="rtl"` for right-to-left text on the assumption it was
   * needed, then measured: librsvg resolves the direction from the text itself,
   * and the render is pixel-identical with the attribute, without it, and
   * against a line forced right-to-left by an embedded mark. It changed
   * nothing, so it is not here.
   *
   * What was actually wrong was the alignment of the finished line, which is
   * the caller's business — see pdf-document.ts.
   */
  let png = wantsFace
    ? drawWithFace(spec.text, spec.family!, fontPx, canvasWidth, canvasHeight, baselinePx, fill)
    : await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">` +
            `<text x="0" y="${baselinePx.toFixed(2)}" font-family="${FONT_STACK}"` +
            ` font-size="${fontPx.toFixed(2)}"${spec.bold ? ' font-weight="bold"' : ''}` +
            ` fill="${fill}">${escapeXml(spec.text)}</text></svg>`,
        ),
      )
        .png()
        .toBuffer()
  let inkWidth = canvasWidth
  let inkHeight = canvasHeight
  let offsetTop = 0

  try {
    /**
     * Crop to the ink to get the true width — no font metrics needed, which is
     * the point: measuring a shaped Arabic line without the shaper is guesswork.
     * `trimOffsetTop` says how far the crop moved, so the baseline is still
     * known afterwards.
     */
    const trimmed = await sharp(png)
      .trim({ threshold: 0 })
      .png()
      .toBuffer({ resolveWithObject: true })
    png = trimmed.data
    inkWidth = trimmed.info.width
    inkHeight = trimmed.info.height
    offsetTop = trimmed.info.trimOffsetTop ?? 0
  } catch {
    // A blank render — nothing to trim. Keep the canvas, so a caller still gets
    // a usable mark rather than an exception.
  }

  const image = await doc.embedPng(png)
  const widthPt = inkWidth / SUPERSAMPLE
  const heightPt = inkHeight / SUPERSAMPLE
  const baselineFromTop = (baselinePx + offsetTop) / SUPERSAMPLE
  const belowBaseline = heightPt - baselineFromTop

  return {
    width: widthPt,
    height: heightPt,
    selectable: false,
    draw(page, at) {
      page.drawImage(image, {
        x: at.x,
        // drawText places the baseline at y; line the image up the same way, so
        // the two paths are interchangeable to a caller.
        y: at.y - belowBaseline,
        width: widthPt,
        height: heightPt,
        ...(at.opacity !== undefined ? { opacity: at.opacity } : {}),
        ...(at.rotate !== undefined ? { rotate: degrees(at.rotate) } : {}),
      })
    },
  }
}
