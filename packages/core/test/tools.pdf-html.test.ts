import { createServer, type Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { htmlToPdf } from '../src/tools/pdf-from-html.js'
import { closeBrowser } from '../src/browser.js'
import { runTool } from '../src/run.js'
import { pageLuminance } from './helpers/pdfink.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let seq = 0
let site: Server
let siteUrl: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<body style="margin:0;background:#000;height:1200px"></body>')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`
}, 60_000)

afterAll(async () => {
  await closeBrowser()
  await new Promise<void>((r) => site.close(() => r()))
  await rm(dir, { recursive: true, force: true })
}, 60_000)

const run = (params: Record<string, unknown>, settings?: Record<string, unknown>) =>
  runTool(htmlToPdf, {
    inputs: [],
    outDir: join(outDir, `h${seq++}`),
    params,
    ...(settings ? { settings: settings as never } : {}),
  })

const pagesOf = async (path: string) =>
  (await PDFDocument.load(await (await import('node:fs/promises')).readFile(path))).getPageCount()

describe('html to PDF', () => {
  it('needs no uploaded file', () => {
    expect(htmlToPdf.inputMode).toBe('none')
    expect(htmlToPdf.family).toBe('pdf')
  })

  it('turns pasted markup into a real PDF', async () => {
    const [out] = await run({ source: 'html', html: '<h1>Report</h1><p>Body text.</p>' })
    expect(out!.mime).toBe('application/pdf')
    expect(await pagesOf(out!.path)).toBeGreaterThanOrEqual(1)
  })

  it('renders the content rather than a blank sheet', async () => {
    const [out] = await run({
      source: 'html',
      html: '<body style="margin:0;background:#000;height:1000px"></body>',
      pageSize: 'a4',
    })
    // A black page renders dark; a blank one would be near white.
    expect(await pageLuminance(out!.path, 1)).toBeLessThan(90)
  })

  it('flows long content onto more than one page', async () => {
    const tall = '<body style="margin:0">' + '<p style="height:400px">block</p>'.repeat(12) + '</body>'
    const [out] = await run({ source: 'html', html: tall, pageSize: 'a4' })
    expect(await pagesOf(out!.path)).toBeGreaterThan(1)
  })

  it('uses the paper size asked for', async () => {
    const [a4] = await run({ source: 'html', html: '<p>x</p>', pageSize: 'a4' })
    const [letter] = await run({ source: 'html', html: '<p>x</p>', pageSize: 'letter' })
    const size = async (path: string) => {
      const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(path))
      return doc.getPage(0).getSize()
    }
    // A4 is 595x842 points, Letter 612x792.
    expect(Math.round((await size(a4!.path)).height)).toBeGreaterThan(Math.round((await size(letter!.path)).height))
  })

  it('turns the page sideways when asked', async () => {
    const [out] = await run({ source: 'html', html: '<p>x</p>', pageSize: 'a4', landscape: true })
    const doc = await PDFDocument.load(await (await import('node:fs/promises')).readFile(out!.path))
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeGreaterThan(height)
  })

  it('renders an allowlisted URL', async () => {
    const [out] = await run({ source: 'url', url: siteUrl, pageSize: 'a4' }, { allowedRenderHosts: ['127.0.0.1'] })
    expect(await pageLuminance(out!.path, 1)).toBeLessThan(90)
  })

  it('refuses a URL when no host is allowlisted', async () => {
    await expect(run({ source: 'url', url: siteUrl })).rejects.toThrow(/not permitted|allowlist/i)
  })

  it('refuses a file:// URL whatever the allowlist says', async () => {
    await expect(
      run({ source: 'url', url: 'file:///etc/passwd' }, { allowedRenderHosts: ['*'] }),
    ).rejects.toThrow()
  })

  it('insists on something to render', () => {
    expect(htmlToPdf.params.safeParse({ source: 'html', html: '   ' }).success).toBe(false)
    expect(htmlToPdf.params.safeParse({ source: 'url', url: '' }).success).toBe(false)
  })
})
