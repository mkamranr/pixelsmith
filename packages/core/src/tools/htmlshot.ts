import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getBrowser } from '../browser.js'
import { BadInputError } from '../errors.js'
import type { RuntimeSettings, Tool } from '../registry.js'

/** Only these two schemes are ever fetched. `file:` in particular is not. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

const NAV_TIMEOUT_MS = 20_000
const SHOT_TIMEOUT_MS = 20_000

export const HtmlShotParams = z
  .object({
    source: z.enum(['html', 'url']).default('html'),
    html: z.string().max(500_000).optional(),
    url: z.string().max(2000).optional(),
    width: z.coerce.number().int().min(50).max(4000).default(1280),
    height: z.coerce.number().int().min(50).max(4000).default(800),
    fullPage: z.boolean().default(false),
    /**
     * Block resources from hosts other than the page's own. On by default: it
     * stops ads, trackers and beacons without a blocklist to maintain. Turn it
     * off when a page genuinely needs its CDN assets to render faithfully.
     */
    blockThirdParty: z.boolean().default(true),
    /**
     * Hide large fixed overlays — cookie banners, newsletter modals — which
     * otherwise cover the very content being captured.
     */
    hideOverlays: z.boolean().default(true),
    deviceScale: z.coerce.number().min(1).max(3).default(1),
    format: z.enum(['png', 'jpeg']).default('png'),
    /** Capture just one element instead of the viewport. */
    selector: z.string().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source === 'html' && (v.html ?? '').trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['html'], message: 'paste some HTML to render' })
    }
    if (v.source === 'url' && (v.url ?? '').trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'give a URL to render' })
    }
  })

export type HtmlShotParams = z.infer<typeof HtmlShotParams>

/**
 * Decide whether a URL may be fetched.
 *
 * Deny by default. An empty allowlist disables URL rendering outright, because
 * a renderer that will fetch any URL it is handed is a server-side request
 * forgery tool — and on an isolated network the reachable hosts are the
 * sensitive ones.
 */
export function checkUrlAllowed(rawUrl: string, settings: RuntimeSettings): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new BadInputError(`${rawUrl} is not a valid URL`)
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new BadInputError(`the ${url.protocol} scheme is not permitted — only http and https`)
  }

  const allowed = settings.allowedRenderHosts
  if (allowed.length === 0) {
    throw new BadInputError(
      'rendering from a URL is not permitted: no render host allowlist is configured on this server',
    )
  }
  if (!allowed.includes('*') && !allowed.includes(url.hostname)) {
    throw new BadInputError(`${url.hostname} is not on this server's render allowlist`)
  }

  return url
}

/**
 * Script evaluated inside the page to hide anything pinned over it that covers
 * a large part of the viewport.
 *
 * Detected by computed style rather than by a list of selectors: cookie-banner
 * class names are endless and change weekly, whereas "fixed and covering a
 * quarter of the screen" describes the actual problem. The area threshold is
 * what keeps an ordinary sticky header visible.
 *
 * Passed as a string on purpose. It runs in the browser, not in Node, and
 * adding DOM types to this package so the compiler would accept it inline would
 * also let `document` slip silently into genuinely server-side code.
 */
const HIDE_OVERLAYS_SCRIPT = `(() => {
  const viewport = window.innerWidth * window.innerHeight;
  if (!viewport) return 0;
  let hidden = 0;
  for (const element of Array.from(document.querySelectorAll('body *'))) {
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const box = element.getBoundingClientRect();
    if (box.width * box.height > viewport * 0.25) {
      element.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
  return hidden;
})()`

export const htmlShot: Tool<HtmlShotParams> = {
  id: 'html-to-image',
  title: 'HTML to image',
  queue: 'render',
  accepts: [],
  inputMode: 'none',
  params: HtmlShotParams,
  ui: {
    group: 'create',
    icon: 'code',
    surface: 'htmlshot',
    preview: 'none',
    blurb: 'Turn a snippet of HTML — a table, a chart, a certificate — into a picture.',
    fields: [
      {
        name: 'source',
        label: 'Render from',
        kind: 'segmented',
        default: 'url',
        options: [
          { value: 'url', label: 'A website URL' },
          { value: 'html', label: 'Pasted HTML' },
        ],
      },
      { name: 'html', label: 'HTML', kind: 'textarea', showWhen: { field: 'source', equals: ['html'] },
        help: 'Inline CSS works. External resources are blocked.' },
      { name: 'url', label: 'URL', kind: 'text', showWhen: { field: 'source', equals: ['url'] },
        help: 'Only hosts an administrator has allowlisted can be reached.' },
      {
        name: 'width',
        label: 'Screen size',
        kind: 'select',
        default: '1280',
        options: [
          { value: '1920', label: 'Desktop wide — 1920px' },
          { value: '1440', label: 'Desktop — 1440px' },
          { value: '1280', label: 'Laptop — 1280px' },
          { value: '1024', label: 'Tablet landscape — 1024px' },
          { value: '768', label: 'Tablet — 768px' },
          { value: '390', label: 'Phone — 390px' },
        ],
      },
      { name: 'height', label: 'Viewport height (px)', kind: 'number', min: 50, max: 4000, default: 800 },
      { name: 'fullPage', label: 'Capture the whole page, not just the viewport', kind: 'toggle', default: true },
      {
        name: 'blockThirdParty',
        label: 'Block third-party resources',
        kind: 'toggle',
        default: true,
        help: 'Keeps ads and trackers out. Turn off if a page needs its CDN assets to look right.',
      },
      { name: 'hideOverlays', label: 'Remove cookie banners and popups', kind: 'toggle', default: true },
      { name: 'deviceScale', label: 'Scale factor', kind: 'number', min: 1, max: 3, default: 1,
        help: '2 renders at twice the resolution, for a crisper image.' },
      {
        name: 'format',
        label: 'Output',
        kind: 'select',
        default: 'png',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPG' },
        ],
      },
      { name: 'selector', label: 'CSS selector', kind: 'text', help: 'Optional. Capture only the first matching element.' },
    ],
  },

  async run({ outDir, params, settings }) {
    const target = params.source === 'url' ? checkUrlAllowed(params.url!, settings) : null

    const browser = await getBrowser(settings.chromiumExecutablePath)
    const context = await browser.newContext({
      viewport: { width: params.width, height: params.height },
      deviceScaleFactor: params.deviceScale,
      javaScriptEnabled: true,
      // No stored state, and nothing carried between jobs.
      storageState: undefined,
    })

    try {
      const page = await context.newPage()

      /**
       * Control what the page may fetch.
       *
       * Pasted HTML gets nothing external at all: it cannot beacon out, pull a
       * remote font, or hang the worker on a host that never answers.
       *
       * A URL render is allowed the page's own origin, because a screenshot of
       * a page stripped of its own stylesheet is worthless. Other origins are
       * blocked unless the operator opts in — which is what makes ads and
       * trackers absent by construction rather than by blocklist.
       */
      await page.route('**/*', (route) => {
        const requestUrl = new URL(route.request().url())

        if (requestUrl.protocol === 'data:' || requestUrl.protocol === 'blob:') return route.continue()
        if (!target) return route.abort()
        if (requestUrl.href === target.href) return route.continue()
        if (requestUrl.host === target.host) return route.continue()
        if (!params.blockThirdParty) return route.continue()
        return route.abort()
      })

      if (target) {
        await page.goto(target.href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
      } else {
        await page.setContent(params.html!, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
      }

      if (params.hideOverlays) {
        await page.evaluate(HIDE_OVERLAYS_SCRIPT)
      }

      const shotOptions = {
        type: params.format,
        timeout: SHOT_TIMEOUT_MS,
        ...(params.format === 'jpeg' ? { quality: 90 } : {}),
      } as const

      let buffer: Buffer
      if (params.selector) {
        const element = await page.locator(params.selector).first()
        if ((await element.count()) === 0) {
          throw new BadInputError(`nothing on the page matches ${params.selector}`)
        }
        buffer = await element.screenshot(shotOptions)
      } else {
        buffer = await page.screenshot({ ...shotOptions, fullPage: params.fullPage })
      }

      const name = `capture.${params.format === 'jpeg' ? 'jpg' : 'png'}`
      const dest = join(outDir, name)
      await writeFile(dest, buffer)

      return [
        {
          path: dest,
          name,
          mime: params.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          bytes: (await stat(dest)).size,
        },
      ]
    } finally {
      // The context goes even if the render failed; leaking one per failed job
      // would exhaust memory on a busy day.
      await context.close()
    }
  },
}
