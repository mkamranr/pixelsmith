import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getBrowser } from '../browser.js'
import { BadInputError } from '../errors.js'
import { PDF_MIME } from '../pdf.js'
import { stem } from '../naming.js'
import { checkUrlAllowed } from './htmlshot.js'
import type { Tool } from '../registry.js'

const NAV_TIMEOUT_MS = 25_000

export const HtmlToPdfParams = z
  .object({
    source: z.enum(['html', 'url']).default('html'),
    html: z.string().max(500_000).optional(),
    url: z.string().max(2000).optional(),
    pageSize: z.enum(['a4', 'letter', 'legal', 'a3']).default('a4'),
    landscape: z.boolean().default(false),
    /** Page margin in millimetres, the unit people specify print margins in. */
    margin: z.coerce.number().min(0).max(50).default(12),
    printBackground: z.boolean().default(true),
    blockThirdParty: z.boolean().default(true),
    filename: z.string().trim().max(120).default('document'),
  })
  .superRefine((v, ctx) => {
    if (v.source === 'html' && (v.html ?? '').trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['html'], message: 'paste some HTML to convert' })
    }
    if (v.source === 'url' && (v.url ?? '').trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'give a URL to convert' })
    }
  })

export type HtmlToPdfParams = z.infer<typeof HtmlToPdfParams>

export const htmlToPdf: Tool<HtmlToPdfParams> = {
  id: 'html-to-pdf',
  title: 'HTML to PDF',
  family: 'pdf',
  queue: 'render',
  accepts: [],
  inputMode: 'none',
  params: HtmlToPdfParams,
  ui: {
    group: 'pdf-convert',
    icon: 'code',
    preview: 'none',
    blurb: 'Turn a web page or a snippet of markup into a paginated PDF.',
    fields: [
      {
        name: 'source',
        label: 'Convert from',
        kind: 'segmented',
        default: 'html',
        options: [
          { value: 'html', label: 'Pasted HTML' },
          { value: 'url', label: 'A website URL' },
        ],
      },
      { name: 'html', label: 'HTML', kind: 'textarea', showWhen: { field: 'source', equals: ['html'] } },
      { name: 'url', label: 'Website URL', kind: 'text', showWhen: { field: 'source', equals: ['url'] },
        help: 'Only hosts an administrator has allowlisted can be reached.' },
      {
        name: 'pageSize',
        label: 'Paper size',
        kind: 'select',
        default: 'a4',
        options: [
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
          { value: 'a3', label: 'A3' },
        ],
      },
      { name: 'landscape', label: 'Landscape', kind: 'toggle', default: false },
      { name: 'margin', label: 'Margin (mm)', kind: 'number', min: 0, max: 50, default: 12 },
      { name: 'printBackground', label: 'Include background colours', kind: 'toggle', default: true },
      { name: 'blockThirdParty', label: 'Block third-party resources', kind: 'toggle', default: true,
        help: 'Keeps ads and trackers out of the document.' },
      { name: 'filename', label: 'Name the result', kind: 'text', default: 'document' },
    ],
  },

  async run({ outDir, params, settings }) {
    const target = params.source === 'url' ? checkUrlAllowed(params.url!, settings) : null

    const browser = await getBrowser(settings.chromiumExecutablePath)
    const context = await browser.newContext()

    try {
      const page = await context.newPage()

      /**
       * The same egress rule as the screenshot tool: pasted markup reaches
       * nothing at all, and a URL render may load its own origin so the
       * document is faithful, but nothing third-party unless the operator
       * opts in.
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

      // Chromium paginates for print media; ask for it explicitly so a page
      // with screen-only styles still lays out as a document.
      await page.emulateMedia({ media: 'print' })

      const margin = `${params.margin}mm`
      const bytes = await page.pdf({
        format: params.pageSize === 'a4' ? 'A4' : params.pageSize === 'a3' ? 'A3' : params.pageSize === 'legal' ? 'Legal' : 'Letter',
        landscape: params.landscape,
        printBackground: params.printBackground,
        margin: { top: margin, right: margin, bottom: margin, left: margin },
      })

      if (bytes.length === 0) throw new BadInputError('nothing was produced')

      const name = `${stem(params.filename || 'document') || 'document'}.pdf`
      const dest = join(outDir, name)
      await writeFile(dest, bytes)

      return [{ path: dest, name, mime: PDF_MIME, bytes: (await stat(dest)).size }]
    } finally {
      await context.close()
    }
  },
}
