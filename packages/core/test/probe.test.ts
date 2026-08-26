import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, probeImage } from '../src/probe.js'
import { MalformedImageError, LimitExceededError, UnsupportedInputError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
beforeAll(async () => {
  dir = await fx.scratchDir()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('probeImage', () => {
  it('identifies a PNG by its bytes and reports real dimensions', async () => {
    const p = await fx.writePng(dir, 'probe.png', 64, 48)
    const probe = await probeImage(p, DEFAULT_LIMITS)
    expect(probe).toMatchObject({ mime: 'image/png', width: 64, height: 48, pages: 1 })
  })

  it('trusts bytes over the filename, so a mislabelled JPEG reports as JPEG', async () => {
    const p = await fx.writeMislabelled(dir, 'liar.png')
    const probe = await probeImage(p, DEFAULT_LIMITS)
    expect(probe.mime).toBe('image/jpeg')
  })

  it('detects SVG, which is text and so has no magic number', async () => {
    const p = await fx.writePlainSvg(dir, 'plain.svg')
    const probe = await probeImage(p, DEFAULT_LIMITS)
    expect(probe.mime).toBe('image/svg+xml')
  })

  it('counts frames of an animated GIF', async () => {
    const p = await fx.writeAnimatedGif(dir, 'anim.gif', 4)
    const probe = await probeImage(p, DEFAULT_LIMITS)
    expect(probe.pages).toBe(4)
  })

  it('rejects a zero-byte file', async () => {
    const p = await fx.writeEmpty(dir, 'empty.png')
    await expect(probeImage(p, DEFAULT_LIMITS)).rejects.toThrow(MalformedImageError)
  })

  it('rejects a file that is not an image at all', async () => {
    const p = await fx.writeTextFile(dir, 'notes.txt')
    await expect(probeImage(p, DEFAULT_LIMITS)).rejects.toThrow(UnsupportedInputError)
  })

  it('rejects a truncated image rather than passing a half-decoded buffer downstream', async () => {
    const p = await fx.writeTruncatedPng(dir, 'cut.png')
    await expect(probeImage(p, DEFAULT_LIMITS)).rejects.toThrow(MalformedImageError)
  })

  it('rejects an image whose pixel count exceeds the bomb limit', async () => {
    const p = await fx.writePng(dir, 'big.png', 200, 200)
    await expect(probeImage(p, { ...DEFAULT_LIMITS, maxPixels: 1000 })).rejects.toThrow(LimitExceededError)
  })

  it('rejects an image exceeding the single-dimension limit', async () => {
    const p = await fx.writePng(dir, 'wide.png', 300, 10)
    await expect(probeImage(p, { ...DEFAULT_LIMITS, maxDimension: 100 })).rejects.toThrow(LimitExceededError)
  })

  it('rejects a file larger than the byte limit before decoding it', async () => {
    const p = await fx.writePng(dir, 'heavy.png', 128, 128)
    await expect(probeImage(p, { ...DEFAULT_LIMITS, maxBytes: 32 })).rejects.toThrow(LimitExceededError)
  })

  it('rejects an animation with more frames than the page limit', async () => {
    const p = await fx.writeAnimatedGif(dir, 'many.gif', 6)
    await expect(probeImage(p, { ...DEFAULT_LIMITS, maxPages: 3 })).rejects.toThrow(LimitExceededError)
  })
})
