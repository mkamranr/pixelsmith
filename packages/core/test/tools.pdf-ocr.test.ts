import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ocrPdf } from '../src/tools/pdf-ocr.js'
import { runTool } from '../src/run.js'
import { ExternalToolFailedError, ExternalToolUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
/** A three-page document, so per-page invocation is observable. */
let scan: string
/** What a stub tesseract hands back as its "recognised" page. */
let onePage: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  const doc = await PDFDocument.create()
  for (let i = 0; i < 3; i++) doc.addPage([300, 400]).drawText(`page ${i + 1}`, { x: 40, y: 200, size: 24 })
  scan = join(dir, 'scan.pdf')
  await writeFile(scan, await doc.save())

  const single = await PDFDocument.create()
  single.addPage([300, 400])
  onePage = join(dir, 'recognised.pdf')
  await writeFile(onePage, await single.save())
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (params: unknown, tesseractPath: string, inputs = [scan]) =>
  runTool(ocrPdf, {
    inputs,
    outDir: join(outDir, `o${seq++}`),
    params,
    settings: { allowedRenderHosts: [], tesseractPath } as never,
  })

/**
 * A stand-in tesseract. The real one is invoked as
 * `tesseract <image> <outputbase> [options] pdf` and writes `<outputbase>.pdf`,
 * so the stub appends a page-shaped PDF there and records its arguments.
 */
async function stubTesseract(name: string, body: string) {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const WRITES_A_PAGE = (log: string) => `echo "$@" >> ${log}\ncp ${onePage} "$2.pdf"\nexit 0`

describe('OCR a PDF', () => {
  it('only offers languages the container actually carries', () => {
    expect(ocrPdf.params.safeParse({ language: 'eng' }).success).toBe(true)
    expect(ocrPdf.params.safeParse({ language: 'eng+ara' }).success).toBe(true)
    // Asking for a language with no traineddata fails inside tesseract with a
    // message about tessdata, which is not a user's problem to decode.
    expect(ocrPdf.params.safeParse({ language: 'klingon' }).success).toBe(false)
  })

  it('recognises every page of the document', async () => {
    const log = join(dir, 'ocr-argv.txt')
    const outs = await run({ language: 'eng' }, await stubTesseract('t-pages', WRITES_A_PAGE(log)))

    const calls = (await readFile(log, 'utf8')).trim().split('\n')
    expect(calls).toHaveLength(3)
    expect(outs).toHaveLength(1)

    const result = await PDFDocument.load(await readFile(outs[0]!.path))
    expect(result.getPageCount()).toBe(3)
    expect(outs[0]!.mime).toBe('application/pdf')
  })

  it('asks tesseract for a PDF in the requested language', async () => {
    const log = join(dir, 'ocr-args2.txt')
    await run({ language: 'eng+ara', dpi: 400 }, await stubTesseract('t-args', WRITES_A_PAGE(log)))

    const [first] = (await readFile(log, 'utf8')).trim().split('\n')
    expect(first).toContain('-l eng+ara')
    // The trailing `pdf` is tesseract's output configfile, and it has to come
    // last: options after a configfile are read as further configfiles.
    expect(first!.trim().endsWith('pdf')).toBe(true)
    expect(first).toContain('--dpi 400')
  })

  it('says plainly when tesseract is not installed', async () => {
    await expect(run({ language: 'eng' }, join(dir, 'absent-tesseract'))).rejects.toThrow(
      ExternalToolUnavailableError,
    )
  })

  it('does not report success when tesseract wrote nothing', async () => {
    // Tesseract exits 0 on some unreadable inputs without producing a file. A
    // finished job with no document is worse than an error.
    const quiet = await stubTesseract('t-silent', 'exit 0')
    await expect(run({ language: 'eng' }, quiet)).rejects.toThrow(ExternalToolFailedError)
  })
})
