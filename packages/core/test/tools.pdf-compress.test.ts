import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfCompress } from '../src/tools/pdf-compress.js'
import { runTool } from '../src/run.js'
import { ExternalToolFailedError, ExternalToolUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let heavy: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  // A document that is genuinely heavy: two pages of high-quality photographic
  // noise, which is what a scanned file looks like to a compressor.
  const doc = await PDFDocument.create()
  const w = 900
  const h = 650
  const px = Buffer.alloc(w * h * 3)
  for (let i = 0; i < px.length; i++) px[i] = (i * 7919) % 256
  const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 100 }).toBuffer()
  const embedded = await doc.embedJpg(jpeg)
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842])
    page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 })
  }
  heavy = join(dir, 'heavy.pdf')
  await writeFile(heavy, await doc.save())
}, 60_000)

afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (inputs: string[], params: unknown = {}, settings?: Record<string, unknown>) =>
  runTool(pdfCompress, {
    inputs,
    outDir: join(outDir, `c${seq++}`),
    params,
    ...(settings ? { settings: settings as never } : {}),
  })

const pagesOf = async (path: string) =>
  (await PDFDocument.load(await (await import('node:fs/promises')).readFile(path))).getPageCount()

/** A stand-in qpdf, so the integration is tested without the real binary. */
async function stubQpdf(name: string, script: string) {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

describe('rebuilding pages as images', () => {
  it('makes the document substantially smaller', async () => {
    const before = (await stat(heavy)).size
    const [out] = await run([heavy], { mode: 'images', dpi: 72, quality: 60 })
    expect(out!.bytes).toBeLessThan(before * 0.6)
  })

  it('keeps every page', async () => {
    const [out] = await run([heavy], { mode: 'images', dpi: 72 })
    expect(await pagesOf(out!.path)).toBe(2)
  })

  it('keeps the page size, so the document still prints correctly', async () => {
    const [out] = await run([heavy], { mode: 'images', dpi: 72 })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    const { width, height } = doc.getPage(0).getSize()
    expect(Math.round(width)).toBe(595)
    expect(Math.round(height)).toBe(842)
  })

  it('goes smaller still in greyscale', async () => {
    const colour = await run([heavy], { mode: 'images', dpi: 72, quality: 60 })
    const grey = await run([heavy], { mode: 'images', dpi: 72, quality: 60, grayscale: true })
    expect(grey[0]!.bytes).toBeLessThan(colour[0]!.bytes)
  })

  it('rejects a resolution that would defeat the point', () => {
    expect(pdfCompress.params.safeParse({ mode: 'images', dpi: 4 }).success).toBe(false)
    expect(pdfCompress.params.safeParse({ mode: 'images', dpi: 2400 }).success).toBe(false)
  })
})

describe('lossless tidy, which needs qpdf', () => {
  it('says plainly when qpdf is not installed', async () => {
    await expect(
      run([heavy], { mode: 'lossless' }, { allowedRenderHosts: [], qpdfPath: join(dir, 'no-such-qpdf') }),
    ).rejects.toThrow(ExternalToolUnavailableError)
  })

  it('names the tool in the message, so an operator knows what to install', async () => {
    const failure = await run([heavy], { mode: 'lossless' }, { allowedRenderHosts: [], qpdfPath: join(dir, 'absent') })
      .catch((e) => e as Error)
    expect(failure.message).toMatch(/qpdf/i)
  })

  it('invokes qpdf with the arguments that actually tidy a document', async () => {
    // The stub records its arguments and copies the input, so the integration
    // is verified without depending on the real binary being present.
    const log = join(dir, 'args.txt')
    // Arguments are [--linearize, --object-streams=generate, input, output].
    const qpdf = await stubQpdf('qpdf-ok', `echo "$@" > ${log}\ncp "$3" "$4"`)
    const [out] = await run([heavy], { mode: 'lossless' }, { allowedRenderHosts: [], qpdfPath: qpdf })

    const args = await (await import('node:fs/promises')).readFile(log, 'utf8')
    expect(args).toContain('--linearize')
    expect(args).toContain('--object-streams=generate')
    expect(out!.mime).toBe('application/pdf')
  })

  it('reports a qpdf failure as a failure, with its message', async () => {
    const qpdf = await stubQpdf('qpdf-bad', 'echo "qpdf: damaged file" >&2\nexit 2')
    const failure = await run([heavy], { mode: 'lossless' }, { allowedRenderHosts: [], qpdfPath: qpdf })
      .catch((e) => e as Error)
    expect(failure).toBeInstanceOf(ExternalToolFailedError)
    expect(failure.message).toMatch(/damaged file/)
  })

  it('treats qpdf exit code 3 as success, since that is only a warning', async () => {
    // qpdf uses 3 for "worked, but the file had recoverable problems".
    const qpdf = await stubQpdf('qpdf-warn', 'cp "$3" "$4"\necho "warning" >&2\nexit 3')
    const outs = await run([heavy], { mode: 'lossless' }, { allowedRenderHosts: [], qpdfPath: qpdf })
    expect(outs).toHaveLength(1)
  })
})
