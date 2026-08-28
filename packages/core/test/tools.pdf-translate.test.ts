import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeLlmSettings } from '../src/llm.js'
import { extractPdfText } from '../src/pdf-text.js'
import { translatePdf } from '../src/tools/pdf-translate.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let server: Server
let port: number
let seq = 0

/** What the stand-in model was asked, so the prompt can be checked. */
let asked: { path: string; body: Record<string, unknown> }[] = []
/** Answers, in order, one per request. */
let replies: string[] = []
/** What the stand-in actually handed back, which is what must not be lost. */
let served: string[] = []

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  /**
   * A real endpoint speaking the OpenAI shape rather than a stubbed fetch, so
   * the request this actually makes is the one under test.
   */
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      asked.push({ path: req.url ?? '', body })

      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
        return
      }

      const reply = replies.shift() ?? 'Traduction.'
      served.push(reply)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
      )
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
 * A document with enough text to exceed one request's budget. Many short lines
 * rather than one long string: drawText keeps only what fits the page width, so
 * a single enormous line would be silently truncated to nothing much.
 */
async function longPdfOf(name: string, characters: number): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const line = 'The committee reviewed the tender and noted the schedule risk.'
  const perPage = 45
  let written = 0
  let page = doc.addPage([420, 620])
  let y = 580

  while (written < characters) {
    if (y < 40) {
      page = doc.addPage([420, 620])
      y = 580
    }
    page.drawText(line, { x: 30, y, size: 9, font })
    written += line.length
    y -= 12
    if (y < 40 && written < characters) continue
    if ((written / line.length) % perPage === 0) y = Math.min(y, 580)
  }

  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

/** `null` means no data directory, and so no model configured. */
const run = (inputs: string[], params: unknown = {}, dataDir: string | null = dir) =>
  runTool(translatePdf, {
    inputs,
    outDir: join(outDir, `t${seq++}`),
    params,
    settings: { allowedRenderHosts: [], ...(dataDir ? { dataDir } : {}) } as never,
  })

describe('translating a document', () => {
  it('sends the document text and writes back what the model returned', async () => {
    asked = []
    replies = ['Le comité a approuvé la prolongation.']
    const src = await pdfOf('minutes.pdf', ['The committee approved the extension.'])

    const outs = await run([src], { language: 'French' })
    const pdf = outs.find((o) => o.mime === 'application/pdf')!

    expect((await extractPdfText(pdf.path)).join(' ')).toContain('approuvé la prolongation')
    const sent = JSON.stringify(asked.at(-1)!.body)
    expect(sent).toContain('The committee approved the extension.')
  })

  it('names the language it was asked for in the instruction', async () => {
    asked = []
    replies = ['نص مترجم.']
    const src = await pdfOf('to-arabic.pdf', ['Some English prose to translate.'])

    await run([src], { language: 'Arabic' })

    expect(JSON.stringify(asked.at(-1)!.body)).toContain('Arabic')
  })

  it('insists on a target language, because there is no sensible default', async () => {
    expect(translatePdf.params.safeParse({}).success).toBe(false)
    expect(translatePdf.params.safeParse({ language: '  ' }).success).toBe(false)
    expect(translatePdf.params.safeParse({ language: 'French' }).success).toBe(true)
  })

  it('hands back the translation as text as well as a document', async () => {
    // The same reason summarising does: the results page can show text, and the
    // text is what anyone wants to paste elsewhere.
    asked = []
    replies = ['Texte traduit.']
    const src = await pdfOf('both.pdf', ['Text to translate.'])

    const outs = await run([src], { language: 'French' })
    const text = outs.find((o) => o.mime === 'text/plain')

    expect(text).toBeDefined()
    expect(await readFile(text!.path, 'utf8')).toContain('Texte traduit.')
  })

  it('translates a long document in parts and keeps every one of them', async () => {
    /**
     * Unlike summarising, nothing may be dropped: a translation missing its
     * second half looks complete, which is worse than one that failed.
     *
     * Asserted against what the stand-in actually handed back rather than
     * against a guess at how many parts the splitter will choose — the split
     * point depends on where the sentences fall, and a test that assumes a
     * count fails when that changes for good reasons.
     */
    asked = []
    served = []
    replies = ['PREMIERE PARTIE.', 'DEUXIEME PARTIE.', 'TROISIEME PARTIE.', 'QUATRIEME PARTIE.']
    const src = await longPdfOf('long.pdf', 30_000)

    const outs = await run([src], { language: 'French' })
    const text = await readFile(outs.find((o) => o.mime === 'text/plain')!.path, 'utf8')

    expect(served.length, 'the document was not split at all').toBeGreaterThan(1)
    for (const part of served) {
      expect(text, `a translated part was dropped: ${part}`).toContain(part)
    }
  })

  it('tells the model which part of the whole it is looking at', async () => {
    // Without it the model has no way to know it is mid-document, and starts
    // translating as though each part were a complete text.
    asked = []
    replies = ['Un.', 'Deux.', 'Trois.', 'Quatre.']
    const src = await longPdfOf('parted.pdf', 30_000)

    await run([src], { language: 'French' })

    expect(JSON.stringify(asked.at(-1)!.body)).toMatch(/part \d+ of \d+/)
  })

  it('says so plainly when no model is configured', async () => {
    const src = await pdfOf('no-model.pdf', ['Anything.'])

    await expect(run([src], { language: 'French' }, null)).rejects.toThrow(/language model/i)
  })

  it('will not pretend to translate a document with no text in it', async () => {
    const blank = await pdfOf('blank.pdf', [])

    await expect(run([blank], { language: 'French' })).rejects.toThrow(/no text|OCR/i)
  })

  it('keeps the source name, with the language on the end', async () => {
    asked = []
    replies = ['Traduit.']
    const src = await pdfOf('contract.pdf', ['Some text.'])

    const outs = await run([src], { language: 'French' })

    expect(outs.find((o) => o.mime === 'application/pdf')!.name).toBe('contract-french.pdf')
  })
})
