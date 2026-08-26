import { createServer, type Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { htmlShot } from '../src/tools/htmlshot.js'
import { closeBrowser } from '../src/browser.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let server: Server
let port: number

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  // A local origin to prove allowlisted URL rendering works.
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<body style="margin:0;background:#111"><h1 style="color:#fff;font:700 48px sans-serif">INTRANET</h1></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as { port: number }).port
}, 60_000)

afterAll(async () => {
  await closeBrowser()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}, 60_000)

/**
 * htmlshot always names its output `capture.png` (each job has its own
 * directory in production), so a test comparing two renders must give each one
 * its own directory or the second silently overwrites the first.
 */
let renderCount = 0
const render = (params: Record<string, unknown>, settings?: Record<string, unknown>) =>
  runTool(htmlShot, {
    inputs: [],
    outDir: join(outDir, `r${renderCount++}`),
    params,
    ...(settings ? { settings: settings as never } : {}),
  })

describe('html to image', () => {
  it('needs no input files at all', () => {
    expect(htmlShot.inputMode).toBe('none')
  })

  it('renders pasted HTML at the requested viewport size', async () => {
    const [out] = await render({ source: 'html', html: '<h1>Hello</h1>', width: 500, height: 300 })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 500, height: 300, format: 'png' })
  })

  it('actually draws the content rather than a blank page', async () => {
    const [out] = await render({
      source: 'html',
      html: '<body style="margin:0;background:#000"><h1 style="color:#fff;font:700 60px sans-serif">CONTENT</h1></body>',
      width: 400,
      height: 200,
    })
    const stats = await sharp(out!.path).stats()
    expect(stats.channels[0]!.stdev).toBeGreaterThan(5)
  })

  it('captures a full page taller than the viewport', async () => {
    const tall = '<body style="margin:0"><div style="height:1400px;background:linear-gradient(#fff,#000)"></div></body>'
    const [out] = await render({ source: 'html', html: tall, width: 400, height: 300, fullPage: true })
    expect((await sharp(out!.path).metadata()).height!).toBeGreaterThan(1000)
  })

  it('writes a JPEG when asked', async () => {
    const [out] = await render({ source: 'html', html: '<p>jpeg</p>', width: 200, height: 150, format: 'jpeg' })
    expect((await sharp(out!.path).metadata()).format).toBe('jpeg')
    expect(out!.name.endsWith('.jpg')).toBe(true)
  })

  it('applies a device scale factor for a sharper image', async () => {
    const [out] = await render({ source: 'html', html: '<p>hi</p>', width: 200, height: 100, deviceScale: 2 })
    expect(await sharp(out!.path).metadata()).toMatchObject({ width: 400, height: 200 })
  })

  it('refuses HTML that is empty', async () => {
    await expect(render({ source: 'html', html: '   ' })).rejects.toThrow()
  })
})

describe('url rendering is locked down', () => {
  it('refuses any URL when no allowlist is configured', async () => {
    await expect(render({ source: 'url', url: `http://127.0.0.1:${port}/` })).rejects.toThrow(/not permitted|allowlist/i)
  })

  it('refuses a host that is not on the allowlist', async () => {
    await expect(
      render({ source: 'url', url: 'http://intranet.invalid/secret' }, { allowedRenderHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(/not permitted|allowlist/i)
  })

  it('renders a host that is on the allowlist', async () => {
    const [out] = await render(
      { source: 'url', url: `http://127.0.0.1:${port}/`, width: 400, height: 200 },
      { allowedRenderHosts: ['127.0.0.1'] },
    )
    const stats = await sharp(out!.path).stats()
    expect(stats.channels[0]!.stdev).toBeGreaterThan(5)
  })

  it.each(['file:///etc/passwd', 'ftp://host/x', 'gopher://host'])(
    'refuses the %s scheme regardless of allowlist',
    async (url) => {
      await expect(render({ source: 'url', url }, { allowedRenderHosts: ['*'] })).rejects.toThrow()
    },
  )

  it('still produces an image when the page references an unreachable external asset', async () => {
    // Air-gapped or not, a page must not be able to hang a worker by pointing
    // at something that never answers.
    const [out] = await render({
      source: 'html',
      html:
        '<body style="margin:0;background:#222">' +
        '<img src="http://example.invalid/never.png">' +
        '<h1 style="color:#fff;font:700 40px sans-serif">STILL RENDERED</h1></body>',
      width: 400,
      height: 200,
    })
    expect((await sharp(out!.path).metadata()).width).toBe(400)
  }, 45_000)
})

describe('rendering a real page from a URL', () => {
  /** A page whose assets live on the same origin, plus one third-party image. */
  let siteUrl: string
  let site: Server
  let thirdPartyHits = 0

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' })
        res.end('body{background:#101820;margin:0} h1{color:#ffd166;font:700 44px sans-serif}')
        return
      }
      if (req.url === '/tracker.png') {
        thirdPartyHits++
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(Buffer.alloc(0))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><head><link rel="stylesheet" href="/style.css"></head>' +
          '<body><div style="position:fixed;inset:0;background:#fff;z-index:9999" class="cookie-banner">' +
          'ACCEPT COOKIES</div><h1>SAME ORIGIN STYLED</h1></body></html>',
      )
    })
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`
  }, 30_000)

  afterAll(async () => {
    await new Promise<void>((r) => site.close(() => r()))
  })

  it('loads the page and its own stylesheet, so the render is faithful', async () => {
    const [out] = await render(
      { source: 'url', url: siteUrl + '/', width: 600, height: 300 },
      { allowedRenderHosts: ['127.0.0.1'] },
    )
    const stats = await sharp(out!.path).stats()
    // The stylesheet paints a dark background; without it the page is white.
    expect(stats.channels[2]!.mean).toBeLessThan(200)
  })

  it('hides fixed overlays when asked, so a cookie banner does not fill the shot', async () => {
    const withBanner = await render(
      { source: 'url', url: siteUrl + '/', width: 600, height: 300, hideOverlays: false },
      { allowedRenderHosts: ['127.0.0.1'] },
    )
    const without = await render(
      { source: 'url', url: siteUrl + '/', width: 600, height: 300, hideOverlays: true },
      { allowedRenderHosts: ['127.0.0.1'] },
    )
    const lightness = async (p: string) => (await sharp(p).stats()).channels[0]!.mean
    // The banner is opaque white across the whole viewport.
    expect(await lightness(withBanner[0]!.path)).toBeGreaterThan(await lightness(without[0]!.path))
  })

  it('blocks third-party requests by default', async () => {
    thirdPartyHits = 0
    await render(
      { source: 'url', url: siteUrl + '/', width: 400, height: 200 },
      { allowedRenderHosts: ['127.0.0.1'] },
    )
    // The page's own assets load; anything off-origin does not.
    expect(thirdPartyHits).toBe(0)
  })

  it('accepts a screen-size preset submitted as a string', () => {
    expect(htmlShot.params.safeParse({ source: 'html', html: '<p>x</p>', width: '1920' }).success).toBe(true)
  })

  it('still refuses a host that is not allowlisted, even with third-party loading on', async () => {
    await expect(
      render(
        { source: 'url', url: 'http://not-allowed.invalid/', blockThirdParty: false },
        { allowedRenderHosts: ['127.0.0.1'] },
      ),
    ).rejects.toThrow(/allowlist|not permitted/i)
  })
})
