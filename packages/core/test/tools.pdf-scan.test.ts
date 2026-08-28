import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadPdf } from '../src/pdf.js'
import { renderPdfPage } from '../src/pdf-render.js'
import { scanPdf } from '../src/tools/pdf-scan.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/**
 * A photograph of a page, as a phone would take it: grey-ish paper rather than
 * white, dark marks for writing, and a dark border where the desk shows around
 * the edges.
 */
async function photoOfAPage(name: string, options: { border?: number; paper?: string } = {}) {
  const border = options.border ?? 0
  const paper = options.paper ?? '#b9b6ae'
  const width = 600
  const height = 800

  const inner = { width: width - border * 2, height: height - border * 2 }

  /**
   * Lines of writing over paper lit unevenly — a phone photograph always is,
   * and that gradient is the mid-range of tones a greyscale scan keeps and a
   * black-and-white one throws away.
   */
  const artwork =
    `<svg width="${inner.width}" height="${inner.height}">` +
    `<defs><linearGradient id="light" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>` +
    `<stop offset="100%" stop-color="#000000" stop-opacity="0.4"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#light)"/>` +
    Array.from({ length: 12 }, (_, row) =>
      `<rect x="60" y="${90 + row * 45}" width="${inner.width - 160}" height="12" fill="#2c2a28"/>`,
    ).join('') +
    `</svg>`

  const page = await sharp({
    create: { ...inner, channels: 3, background: paper },
  })
    .composite([{ input: Buffer.from(artwork), top: 0, left: 0 }])
    .png()
    .toBuffer()

  const path = join(dir, name)
  if (border === 0) {
    await sharp(page).toFile(path)
  } else {
    await sharp({ create: { width, height, channels: 3, background: '#2b2b2b' } })
      .composite([{ input: page, top: border, left: border }])
      .png()
      .toFile(path)
  }
  return path
}

const run = (inputs: string[], params: unknown = {}) =>
  runTool(scanPdf, {
    inputs,
    outDir: join(outDir, `s${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })

/** How light the lightest areas are: paper that has been whitened reads high. */
async function paperBrightness(pdfPath: string): Promise<number> {
  const png = await renderPdfPage(pdfPath, 1, { scale: 1 })
  const { channels } = await sharp(png).greyscale().stats()
  return channels[0]!.max
}

/** Spread of tones. A thresholded page has almost none in the middle. */
async function midTones(pdfPath: string): Promise<number> {
  const png = await renderPdfPage(pdfPath, 1, { scale: 1 })
  const raw = await sharp(png).greyscale().raw().toBuffer()
  let middling = 0
  for (const value of raw) if (value > 70 && value < 185) middling += 1
  return middling / raw.length
}

describe('making a scan out of photographs', () => {
  it('gathers the photographs into one document', async () => {
    const one = await photoOfAPage('shot-1.png')
    const two = await photoOfAPage('shot-2.png')

    const [out] = await run([one, two], { filename: 'minutes' })

    expect(out!.name).toBe('minutes.pdf')
    expect((await loadPdf(out!.path)).getPageCount()).toBe(2)
  })

  it('whitens the paper, which a photograph never does on its own', async () => {
    // The point of the tool: a photograph of a white page is grey, and looks
    // like a photograph. A scan looks like a scan.
    const shot = await photoOfAPage('grey-paper.png', { paper: '#b9b6ae' })

    const plain = await run([shot], { enhance: false })
    const scanned = await run([shot], { enhance: true })

    expect(await paperBrightness(scanned[0]!.path)).toBeGreaterThan(
      await paperBrightness(plain[0]!.path),
    )
  })

  it('can reduce the page to black and white, as a fax would', async () => {
    const shot = await photoOfAPage('bw.png')

    const grey = await run([shot], { mode: 'grey' })
    const mono = await run([shot], { mode: 'mono' })

    // Thresholding empties the middle of the range.
    expect(await midTones(mono[0]!.path)).toBeLessThan(await midTones(grey[0]!.path))
  })

  it('keeps the colours when asked to', async () => {
    const shot = await photoOfAPage('colour.png', { paper: '#c8b48a' })

    const [out] = await run([shot], { mode: 'colour', enhance: false })
    const png = await renderPdfPage(out!.path, 1, { scale: 0.4 })
    const { channels } = await sharp(png).stats()

    // A greyscale page has identical channel means; a coloured one does not.
    expect(Math.abs(channels[0]!.mean - channels[2]!.mean)).toBeGreaterThan(2)
  })

  it('takes the colour out for a greyscale scan', async () => {
    // The mirror of the test above, and the one that was missing: keeping
    // colour was checked, removing it was not — so dropping the greyscale
    // conversion altogether broke nothing.
    const shot = await photoOfAPage('to-grey.png', { paper: '#c8b48a' })

    const [out] = await run([shot], { mode: 'grey', enhance: false })
    const png = await renderPdfPage(out!.path, 1, { scale: 0.4 })
    const { channels } = await sharp(png).stats()

    expect(Math.abs(channels[0]!.mean - channels[2]!.mean)).toBeLessThan(1.5)
  })

  it('trims the desk from around the page', async () => {
    // A phone photograph has whatever the page was lying on around the edges.
    const shot = await photoOfAPage('bordered.png', { border: 60 })

    const kept = await run([shot], { trim: false })
    const trimmed = await run([shot], { trim: true })

    const area = async (path: string) => {
      const page = (await loadPdf(path)).getPage(0).getSize()
      return page.width * page.height
    }

    expect(await area(trimmed[0]!.path)).toBeLessThan(await area(kept[0]!.path))
  })

  it('refuses a PDF, because it makes them rather than reads them', () => {
    expect(scanPdf.accepts).not.toContain('application/pdf')
  })

  it('names the document sensibly when given nothing to go on', async () => {
    const shot = await photoOfAPage('unnamed.png')

    const [out] = await run([shot])

    expect(out!.name).toMatch(/\.pdf$/)
    expect(out!.mime).toBe('application/pdf')
  })
})
