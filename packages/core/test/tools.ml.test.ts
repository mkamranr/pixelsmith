import { createServer, type Server } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeBackground } from '../src/tools/remove-background.js'
import { upscale } from '../src/tools/upscale.js'
import { blurFaces } from '../src/tools/blur-faces.js'
import { runTool } from '../src/run.js'
import { InferenceUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let server: Server
let inferenceUrl: string

/**
 * Requests the stub received. `dims` is measured while the stub still holds the
 * file: an oriented copy lives in a temp directory that is deleted as soon as
 * the call returns, so a test cannot inspect the path afterwards — nor should
 * it be able to, since a leftover temp file would be a leak.
 */
const seen: { path: string; body: Record<string, unknown>; dims?: { width: number; height: number } }[] = []
/** Lets a test make the stub misbehave. */
let nextResponse: { status: number; body: unknown } | null = null

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  /**
   * A stand-in for the Python sidecar. Tests here verify the client, the
   * request shape and the error mapping; that the models themselves work is
   * verified separately against the real service.
   */
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      const entry: (typeof seen)[number] = { path: req.url!, body }
      try {
        const probe = await sharp(String(body.in_path)).metadata()
        entry.dims = { width: probe.width ?? 0, height: probe.height ?? 0 }
      } catch {
        // Some tests post no readable input; dims stays undefined.
      }
      seen.push(entry)

      if (nextResponse) {
        const { status, body: payload } = nextResponse
        nextResponse = null
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }

      // Produce a real file so the tool's stat() and probe of the result work.
      const channels = req.url === '/remove-background' && !body.background ? 4 : 3
      const scale = req.url === '/upscale' ? (body.scale as number) : 1
      await sharp({
        create: { width: 40 * scale, height: 30 * scale, channels: channels as 3 | 4, background: '#334455' },
      })
        .png()
        .toFile(body.out_path as string)

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ width: 40 * scale, height: 30 * scale, detected: 2, regions: 2 }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  inferenceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

const settings = () => ({ allowedRenderHosts: [], inferenceUrl })
const lastCall = () => seen[seen.length - 1]!

describe('remove background', () => {
  it('sends the staged input and output paths to the sidecar', async () => {
    const src = await fx.writePng(dir, 'rb.png', 60, 40)
    await runTool(removeBackground, { inputs: [src], outDir, params: {}, settings: settings() })

    expect(lastCall().path).toBe('/remove-background')
    expect(lastCall().body.in_path).toBe(src)
    expect(String(lastCall().body.out_path)).toContain(outDir)
  })

  it('asks for transparency by default, and writes a PNG to keep it', async () => {
    const src = await fx.writeJpeg(dir, 'rb2.jpg', 60, 40)
    const [out] = await runTool(removeBackground, { inputs: [src], outDir, params: {}, settings: settings() })

    expect(lastCall().body.background).toBeNull()
    // A JPEG input must still come back as PNG: JPEG cannot hold an alpha channel.
    expect(out!.name).toBe('rb2.png')
    expect(out!.mime).toBe('image/png')
  })

  it('passes a replacement background colour through', async () => {
    const src = await fx.writePng(dir, 'rb3.png', 60, 40)
    await runTool(removeBackground, {
      inputs: [src], outDir, params: { background: '#ff0000' }, settings: settings(),
    })
    expect(lastCall().body.background).toBe('#ff0000')
  })

  it('offers the faster lightweight model', async () => {
    const src = await fx.writePng(dir, 'rb4.png', 60, 40)
    await runTool(removeBackground, { inputs: [src], outDir, params: { model: 'u2netp' }, settings: settings() })
    expect(lastCall().body.model).toBe('u2netp')
  })

  it('explains itself when the sidecar is not configured at all', async () => {
    const src = await fx.writePng(dir, 'rb5.png', 60, 40)
    await expect(
      runTool(removeBackground, { inputs: [src], outDir, params: {}, settings: { allowedRenderHosts: [] } }),
    ).rejects.toThrow(InferenceUnavailableError)
  })

  it('surfaces a missing model as an unavailable service, not a generic failure', async () => {
    const src = await fx.writePng(dir, 'rb6.png', 60, 40)
    nextResponse = { status: 503, body: { detail: 'model file not found: /models/u2net.onnx' } }
    await expect(
      runTool(removeBackground, { inputs: [src], outDir, params: {}, settings: settings() }),
    ).rejects.toThrow(/model file not found/)
  })

  it('reports a rejected input as a bad input', async () => {
    const src = await fx.writePng(dir, 'rb7.png', 60, 40)
    nextResponse = { status: 422, body: { detail: 'could not read image' } }
    await expect(
      runTool(removeBackground, { inputs: [src], outDir, params: {}, settings: settings() }),
    ).rejects.toThrow(/could not read image/)
  })
})

describe('upscale', () => {
  it('asks for the requested scale factor', async () => {
    const src = await fx.writePng(dir, 'up.png', 40, 30)
    const [out] = await runTool(upscale, { inputs: [src], outDir, params: { scale: 4 }, settings: settings() })
    expect(lastCall().body.scale).toBe(4)
    expect((await sharp(out!.path).metadata()).width).toBe(160)
  })

  it('defaults to doubling', async () => {
    const src = await fx.writePng(dir, 'up2.png', 40, 30)
    await runTool(upscale, { inputs: [src], outDir, params: {}, settings: settings() })
    expect(lastCall().body.scale).toBe(2)
  })

  it('rejects a scale factor the models do not provide', () => {
    expect(upscale.params.safeParse({ scale: 3 }).success).toBe(false)
    expect(upscale.params.safeParse({ scale: 8 }).success).toBe(false)
  })

  it('refuses an input large enough that upscaling would exhaust memory', async () => {
    const src = await fx.writePng(dir, 'huge.png', 300, 300)
    await expect(
      runTool(upscale, {
        inputs: [src], outDir, params: { scale: 4 }, settings: settings(),
        limits: { maxBytes: 1e9, maxPixels: 1e9, maxDimension: 40000, maxPages: 10 },
      }),
    ).resolves.toBeTruthy()

    // 4x of a 20-megapixel image is 320 megapixels, which is refused up front.
    const big = await fx.writePng(dir, 'toobig.png', 5000, 4000)
    await expect(
      runTool(upscale, { inputs: [big], outDir, params: { scale: 4 }, settings: settings() }),
    ).rejects.toThrow(/too large|exceed/i)
  }, 60_000)
})

describe('blur faces', () => {
  it('requests detection and redaction together', async () => {
    const src = await fx.writePng(dir, 'bf.png', 60, 40)
    await runTool(blurFaces, { inputs: [src], outDir, params: {}, settings: settings() })
    expect(lastCall().path).toBe('/blur-faces')
    expect(lastCall().body.detect).toBe(true)
    expect(lastCall().body.method).toBe('blur')
  })

  it('supports pixelation and solid boxes as alternatives', async () => {
    const src = await fx.writePng(dir, 'bf2.png', 60, 40)
    for (const method of ['pixelate', 'box'] as const) {
      await runTool(blurFaces, { inputs: [src], outDir: join(outDir, method), params: { method }, settings: settings() })
      expect(lastCall().body.method).toBe(method)
    }
  })

  it('passes the confidence threshold through', async () => {
    const src = await fx.writePng(dir, 'bf3.png', 60, 40)
    await runTool(blurFaces, { inputs: [src], outDir, params: { confidence: 40 }, settings: settings() })
    // Exposed as a percentage in the UI, sent as a fraction.
    expect(lastCall().body.confidence).toBeCloseTo(0.4)
  })

  it('rejects a confidence outside the sensible range', () => {
    expect(blurFaces.params.safeParse({ confidence: 0 }).success).toBe(false)
    expect(blurFaces.params.safeParse({ confidence: 101 }).success).toBe(false)
  })
})

describe('blur faces with operator corrections', () => {
  it('sends manually added regions alongside detection', async () => {
    const src = await fx.writePng(dir, 'bf-manual.png', 200, 100)
    await runTool(blurFaces, {
      inputs: [src],
      outDir: join(outDir, 'manual'),
      params: { regions: JSON.stringify([{ x: 10, y: 20, width: 30, height: 40 }]) },
      settings: settings(),
    })
    expect(lastCall().body.extra_regions).toEqual([{ x: 10, y: 20, width: 30, height: 40 }])
    expect(lastCall().body.detect).toBe(true)
  })

  it('can turn detection off entirely, redacting only what the operator marked', async () => {
    const src = await fx.writePng(dir, 'bf-only.png', 200, 100)
    await runTool(blurFaces, {
      inputs: [src],
      outDir: join(outDir, 'only'),
      params: {
        detect: false,
        regions: JSON.stringify([{ x: 1, y: 2, width: 3, height: 4 }]),
      },
      settings: settings(),
    })
    expect(lastCall().body.detect).toBe(false)
    expect(lastCall().body.extra_regions).toHaveLength(1)
  })

  it('treats an absent region list as none, not as an error', async () => {
    const src = await fx.writePng(dir, 'bf-none.png', 200, 100)
    await runTool(blurFaces, { inputs: [src], outDir: join(outDir, 'none'), params: {}, settings: settings() })
    expect(lastCall().body.extra_regions).toEqual([])
  })

  it('rejects a malformed region list rather than silently ignoring it', async () => {
    const src = await fx.writePng(dir, 'bf-bad.png', 200, 100)
    await expect(
      runTool(blurFaces, {
        inputs: [src], outDir: join(outDir, 'bad'), params: { regions: 'not json' }, settings: settings(),
      }),
    ).rejects.toThrow()
  })

  it('rejects a region with negative geometry', async () => {
    const src = await fx.writePng(dir, 'bf-neg.png', 200, 100)
    await expect(
      runTool(blurFaces, {
        inputs: [src], outDir: join(outDir, 'neg'),
        params: { regions: JSON.stringify([{ x: -5, y: 0, width: 10, height: 10 }]) },
        settings: settings(),
      }),
    ).rejects.toThrow()
  })

  it('refuses a job that would redact nothing at all', () => {
    // Detection off with no manual regions cannot alter the image; returning it
    // unchanged while implying it was redacted is the dangerous outcome.
    expect(blurFaces.params.safeParse({ detect: false }).success).toBe(false)
    expect(blurFaces.params.safeParse({ detect: false, regions: '[]' }).success).toBe(false)
  })

  it('accepts detection presets as strings, the way a form submits them', () => {
    for (const value of ['40', '70', '90']) {
      expect(blurFaces.params.safeParse({ confidence: value }).success).toBe(true)
    }
  })
})

describe('blur faces across a batch', () => {
  /**
   * Every test above uses one photo, which is why this went unnoticed: the
   * marked areas were handed to every file in the batch identically, so a box
   * drawn over a face in the first photo blurred those same coordinates in the
   * second and third — where there is no face, and where the real one is left
   * showing. Crop applies one rectangle to a whole batch deliberately; faces
   * are not in the same place twice.
   */
  const callsFrom = (mark: number) => seen.slice(mark).filter((c) => c.path === '/blur-faces')

  it('marks the photo the area was drawn on, and not the others', async () => {
    const one = await fx.writePng(dir, 'batch-1.png', 200, 100)
    const two = await fx.writePng(dir, 'batch-2.png', 200, 100)
    const mark = seen.length

    await runTool(blurFaces, {
      inputs: [one, two],
      outDir: join(outDir, 'batch-one'),
      params: { detect: false, regions: JSON.stringify([{ file: 1, x: 10, y: 20, width: 30, height: 40 }]) },
      settings: settings(),
    })

    const calls = callsFrom(mark)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.extra_regions).toEqual([])
    expect(calls[1]!.body.extra_regions).toEqual([{ x: 10, y: 20, width: 30, height: 40 }])
  })

  it('still applies an area given without a photo to all of them', async () => {
    // The batch of identically laid out scans, where the same corner is to be
    // covered on every page. This is what the parameter used to mean, and a
    // caller written against it keeps working.
    const one = await fx.writePng(dir, 'batch-3.png', 200, 100)
    const two = await fx.writePng(dir, 'batch-4.png', 200, 100)
    const mark = seen.length

    await runTool(blurFaces, {
      inputs: [one, two],
      outDir: join(outDir, 'batch-all'),
      params: { detect: false, regions: JSON.stringify([{ x: 5, y: 5, width: 10, height: 10 }]) },
      settings: settings(),
    })

    for (const call of callsFrom(mark)) {
      expect(call.body.extra_regions).toEqual([{ x: 5, y: 5, width: 10, height: 10 }])
    }
  })

  it('gives a photo both its own areas and the ones meant for all', async () => {
    const one = await fx.writePng(dir, 'batch-5.png', 200, 100)
    const two = await fx.writePng(dir, 'batch-6.png', 200, 100)
    const mark = seen.length

    await runTool(blurFaces, {
      inputs: [one, two],
      outDir: join(outDir, 'batch-both'),
      params: {
        detect: false,
        regions: JSON.stringify([
          { x: 1, y: 1, width: 2, height: 2 },
          { file: 0, x: 50, y: 50, width: 20, height: 20 },
        ]),
      },
      settings: settings(),
    })

    const calls = callsFrom(mark)
    expect(calls[0]!.body.extra_regions).toHaveLength(2)
    expect(calls[1]!.body.extra_regions).toHaveLength(1)
  })

  it('refuses an area pointing at a photo that was not uploaded', async () => {
    // Silently dropping it would leave a face the operator marked showing, in a
    // picture they were told had been dealt with. That is the one outcome this
    // tool cannot have.
    const only = await fx.writePng(dir, 'batch-7.png', 200, 100)

    await expect(
      runTool(blurFaces, {
        inputs: [only],
        outDir: join(outDir, 'batch-dangling'),
        params: { detect: false, regions: JSON.stringify([{ file: 3, x: 1, y: 1, width: 2, height: 2 }]) },
        settings: settings(),
      }),
    ).rejects.toThrow(/marked area/i)
  })
})

describe('EXIF orientation before inference', () => {
  /**
   * Phones store a portrait photo as landscape pixels plus a rotate flag. The
   * Python sidecar reads with cv2.IMREAD_UNCHANGED, which ignores that flag —
   * so unless the orientation is baked in first, every such photo comes back
   * rotated. sharp-based tools already do this via autoOrient().
   */
  async function rotatedJpeg(name: string) {
    const p = join(dir, name)
    await sharp({ create: { width: 120, height: 60, channels: 3, background: '#3366aa' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(p)
    return p
  }

  it('hands the sidecar an image whose rotation is already applied', async () => {
    const src = await rotatedJpeg('spin.jpg')
    expect(await sharp(src).metadata()).toMatchObject({ width: 120, height: 60, orientation: 6 })

    await runTool(removeBackground, {
      inputs: [src], outDir: join(outDir, 'exif'), params: {}, settings: settings(),
    })

    // Whatever the sidecar was handed must already read as 60x120.
    expect(lastCall().dims).toEqual({ width: 60, height: 120 })
  })

  it('applies orientation for upscaling too', async () => {
    const src = await rotatedJpeg('spin2.jpg')
    await runTool(upscale, { inputs: [src], outDir: join(outDir, 'exif2'), params: {}, settings: settings() })
    expect(lastCall().dims).toEqual({ width: 60, height: 120 })
  })

  it('applies orientation for face redaction too', async () => {
    const src = await rotatedJpeg('spin3.jpg')
    await runTool(blurFaces, { inputs: [src], outDir: join(outDir, 'exif3'), params: {}, settings: settings() })
    expect(lastCall().dims).toEqual({ width: 60, height: 120 })
  })

  it('passes an already-upright image straight through, with no re-encode', async () => {
    const src = await fx.writePng(dir, 'upright.png', 90, 40)
    await runTool(removeBackground, {
      inputs: [src], outDir: join(outDir, 'plain'), params: {}, settings: settings(),
    })
    // Same path, not a copy: the common case must not pay for this.
    expect(lastCall().body.in_path).toBe(src)
  })

  it('sizes the upscale limit from the oriented dimensions', async () => {
    // 60x120 at 4x is 28,800 px — comfortably allowed. The check must not read
    // the pre-rotation shape and reach a different verdict.
    const src = await rotatedJpeg('spin4.jpg')
    await expect(
      runTool(upscale, { inputs: [src], outDir: join(outDir, 'exif4'), params: { scale: 4 }, settings: settings() }),
    ).resolves.toHaveLength(1)
  })
})
