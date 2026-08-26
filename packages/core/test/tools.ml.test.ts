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

/** Requests the stub received, so tests can assert what was actually sent. */
const seen: { path: string; body: Record<string, unknown> }[] = []
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
      seen.push({ path: req.url!, body })

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
