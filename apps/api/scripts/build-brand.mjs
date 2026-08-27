// Brand assets, derived from one source image.
//
// The logo arrives as a flat PNG on a white ground. The app has dark surfaces,
// so the ground has to go — but only the ground: the white shapes *inside* the
// mark (the inner p, the PDF label, the picture icon) are part of the artwork.
// A plain "make white transparent" pass would punch holes in all of them, so the
// background is found by flooding inwards from the edges instead. White that is
// not reachable from outside the mark stays white.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** A channel value at or above this, on all three channels, reads as paper. */
const PAPER = 242

/** The bands the source is laid out in, measured rather than assumed. */
const MIN_BAND_HEIGHT = 8

export const BRAND_FILES = [
  'mark.png',
  'lockup.png',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-64.png',
  'apple-touch-icon.png',
  'icon-512.png',
]

/**
 * Replace the paper the artwork sits on with transparency.
 *
 * Returns raw RGBA plus the geometry, so callers can crop without decoding the
 * PNG again.
 */
export async function keyOutPaper(sourcePath) {
  const { data, info } = await sharp(sourcePath).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const at = (x, y) => (y * width + x) * channels
  const isPaper = (x, y) => {
    const i = at(x, y)
    return data[i] >= PAPER && data[i + 1] >= PAPER && data[i + 2] >= PAPER
  }

  // Flood inwards from every edge pixel that is paper. Four-connected, with an
  // explicit stack: a recursive fill on a million pixels overflows.
  const background = new Uint8Array(width * height)
  const stack = []
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const key = y * width + x
    if (background[key] || !isPaper(x, y)) return
    background[key] = 1
    stack.push(key)
  }

  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }

  while (stack.length > 0) {
    const key = stack.pop()
    const x = key % width
    const y = (key - x) / width
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = at(x, y)
      const to = (y * width + x) * 4
      rgba[to] = data[from]
      rgba[to + 1] = data[from + 1]
      rgba[to + 2] = data[from + 2]
      rgba[to + 3] = background[y * width + x] ? 0 : 255
    }
  }

  return { rgba, width, height }
}

/** The horizontal bands of artwork, and each one's extent. */
export function findBands({ rgba, width, height }) {
  const opaque = (x, y) => rgba[(y * width + x) * 4 + 3] > 0
  const bands = []
  let start = null

  for (let y = 0; y <= height; y++) {
    let count = 0
    if (y < height) for (let x = 0; x < width; x++) if (opaque(x, y)) count++
    const inked = y < height && count > 2

    if (inked && start === null) start = y
    if (!inked && start !== null) {
      if (y - start >= MIN_BAND_HEIGHT) {
        let left = width
        let right = 0
        for (let row = start; row < y; row++) {
          for (let x = 0; x < width; x++) {
            if (!opaque(x, row)) continue
            if (x < left) left = x
            if (x > right) right = x
          }
        }
        bands.push({ top: start, bottom: y - 1, left, right })
      }
      start = null
    }
  }

  return bands
}

const crop = ({ rgba, width, height }, box) =>
  sharp(rgba, { raw: { width, height, channels: 4 } }).extract({
    left: box.left,
    top: box.top,
    width: box.right - box.left + 1,
    height: box.bottom - box.top + 1,
  })

/**
 * A square version of the mark, padded with transparency.
 *
 * Padding has to be added *after* cropping. Growing the crop box to a square
 * instead reaches into whatever the source has next to the mark — which here is
 * the wordmark, and it turned up shrunk to illegibility inside every icon.
 */
async function squareMark(keyed, box, bleed = 24) {
  const boxWidth = box.right - box.left + 1
  const boxHeight = box.bottom - box.top + 1
  const side = Math.max(boxWidth, boxHeight) + bleed * 2
  const exact = await crop(keyed, box).png().toBuffer()

  return sharp(exact).extend({
    left: Math.floor((side - boxWidth) / 2),
    right: Math.ceil((side - boxWidth) / 2),
    top: Math.floor((side - boxHeight) / 2),
    bottom: Math.ceil((side - boxHeight) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
}

export async function buildBrandAssets(sourcePath, destDir) {
  const keyed = await keyOutPaper(sourcePath)
  const bands = findBands(keyed)
  if (bands.length < 3) {
    throw new Error(`expected the mark, wordmark and tagline in the source; found ${bands.length} bands`)
  }

  const [mark, wordmark, tagline] = bands
  await mkdir(destDir, { recursive: true })

  /**
   * The mark on its own, for the header and the home page.
   *
   * One asset for both, sized for the larger use at twice the density — the
   * header simply draws it smaller, which costs one request instead of two. At
   * 512px this was 199KB; sized to what the page actually shows, and with the
   * encoder given room to work, it is a fourteenth of that and still lossless.
   */
  await crop(keyed, mark)
    .resize({ height: 224 })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(join(destDir, 'mark.png'))

  // Mark, name and tagline together, for the home page and the sign-in page.
  const lockup = {
    top: mark.top,
    bottom: tagline.bottom,
    left: Math.min(mark.left, wordmark.left, tagline.left),
    right: Math.max(mark.right, wordmark.right, tagline.right),
  }
  await crop(keyed, lockup)
    .resize({ width: 900 })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(join(destDir, 'lockup.png'))

  // Square icons, from the mark alone.
  const icon = await (await squareMark(keyed, mark)).png().toBuffer()
  for (const [name, size] of [
    ['favicon-16.png', 16],
    ['favicon-32.png', 32],
    ['favicon-64.png', 64],
    ['apple-touch-icon.png', 180],
    ['icon-512.png', 512],
  ]) {
    await sharp(icon)
      .resize({ width: size, height: size, fit: 'inside' })
      .png({ compressionLevel: 9, effort: 10 })
      .toFile(join(destDir, name))
  }

  return { bands }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const source = fileURLToPath(new URL('../../../assets/brand/pixelsmith-source.png', import.meta.url))
  const dest = fileURLToPath(new URL('../public/brand', import.meta.url))
  const { bands } = await buildBrandAssets(source, dest)
  console.log(`brand assets written from ${bands.length} bands`)
}
