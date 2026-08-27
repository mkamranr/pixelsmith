import { createServer, type Server } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { summarisePdf } from '../src/tools/pdf-summarise.js'
import { writeLlmSettings } from '../src/llm.js'
import { extractPdfText } from '../src/pdf-text.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let server: Server
let port: number
let seq = 0

/** What the stand-in model was asked, so the prompt can be checked. */
let asked: { path: string; body: Record<string, unknown> }[] = []
/** What it answers for a part; the combining call is answered separately. */
let replies: string[] = []

/** A phrase the combining prompt contains and a part prompt does not. */
const COMBINE_MARKER = 'summaries of one document'

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  /**
   * A real HTTP endpoint speaking the OpenAI shape, rather than a stubbed
   * fetch: it exercises the request this will actually make, headers and all.
   */
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      asked.push({ path: req.url ?? '', body })

      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
        return
      }

      const said = JSON.stringify(body)
      const reply = said.includes(COMBINE_MARKER)
        ? 'Both parts together.'
        : (replies.shift() ?? 'A summary.')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port

  await writeLlmSettings(dir, {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    verifiedAt: Date.now(),
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

async function pdfOf(name: string, pages: string[]): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    doc.addPage([420, 560]).drawText(text, { x: 40, y: 480, size: 12, font })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

/**
 * A document with real body text: many short lines, as a page actually has.
 *
 * One enormous drawText will not do. pdf-lib keeps only what fits a single
 * line, so a 20,000-character string reaches the file as about seventy
 * characters — the fixture looks long and contains almost nothing.
 */
async function longPdf(name: string, pageCount: number): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)

  for (let page = 0; page < pageCount; page++) {
    const sheet = doc.addPage([420, 560])
    for (let line = 0; line < 40; line++) {
      sheet.drawText(`Procurement note ${page + 1}.${line + 1}: the committee reviewed the tender.`, {
        x: 30,
        y: 520 - line * 13,
        size: 9,
        font,
      })
    }
  }

  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

/** `null` means no data directory, and so no model. Passing `undefined` would
 *  fall back to the default, which is the opposite of what that test wants. */
const run = (inputs: string[], params: unknown = {}, dataDir: string | null = dir) =>
  runTool(summarisePdf, {
    inputs,
    outDir: join(outDir, `s${seq++}`),
    params,
    settings: { allowedRenderHosts: [], ...(dataDir ? { dataDir } : {}) } as never,
  })

describe('summarising a document', () => {
  it('sends the document text and writes what came back', async () => {
    asked = []
    replies = ['The report proposes three changes to the tendering process.']
    const src = await pdfOf('report.pdf', ['Tendering review', 'Recommendations follow.'])

    const outs = await run([src])

    expect(outs).toHaveLength(1)
    expect(outs[0]!.name).toBe('report-summary.pdf')
    const written = (await extractPdfText(outs[0]!.path)).join(' ')
    expect(written).toContain('three changes to the tendering process')

    // The document's own words went to the model, not its file name.
    const sent = JSON.stringify(asked.at(-1)!.body)
    expect(sent).toContain('Tendering review')
    expect(asked.at(-1)!.path).toContain('/chat/completions')
  })

  it('asks for the length it was told to', async () => {
    asked = []
    replies = ['Short.']
    const src = await pdfOf('len.pdf', ['Some content to condense.'])

    await run([src], { length: 'brief' })
    expect(JSON.stringify(asked.at(-1)!.body).toLowerCase()).toMatch(/brief|one paragraph|short/)
  })

  it('can be asked for the summary in another language', async () => {
    asked = []
    replies = ['ملخص']
    const src = await pdfOf('lang.pdf', ['Content in English.'])

    await run([src], { language: 'Arabic' })
    expect(JSON.stringify(asked.at(-1)!.body)).toContain('Arabic')
  })

  it('summarises a long document in parts, then summarises those', async () => {
    /**
     * A model's context is finite and a document is not. Long input is broken
     * up, each part summarised, and the parts summarised together — so the
     * answer covers the whole document rather than its first few pages.
     */
    asked = []
    replies = []
    // Twelve pages of forty lines is comfortably past what goes in one request.
    const src = await longPdf('long.pdf', 12)

    const outs = await run([src], { length: 'standard' })

    // More than one call: the parts, and then a call to put them together.
    const calls = asked.filter((call) => call.path.includes('chat'))
    expect(calls.length).toBeGreaterThan(2)
    expect(calls.some((call) => JSON.stringify(call.body).includes(COMBINE_MARKER))).toBe(true)
    expect((await extractPdfText(outs[0]!.path)).join(' ')).toContain('Both parts together')
  })

  it('says so plainly when no model is configured', async () => {
    const src = await pdfOf('nomodel.pdf', ['Anything.'])
    await expect(run([src], {}, null)).rejects.toThrow(/not configured|no language model/i)
  })

  it('will not pretend to summarise a document with no text in it', async () => {
    // A scan has no text until it has been through OCR, and a summary of
    // nothing would be invented.
    const blank = await PDFDocument.create()
    blank.addPage([300, 400])
    const path = join(dir, 'blank.pdf')
    await writeFile(path, await blank.save())

    await expect(run([path])).rejects.toThrow(/no text|OCR/i)
  })
})
