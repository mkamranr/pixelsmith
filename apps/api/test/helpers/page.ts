import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url))

/**
 * A page with one of the browser scripts running on it.
 *
 * The scripts that make the tools direct — dragging a crop box, cutting a
 * document between two pages, drawing a signature — hold real logic, and until
 * now the only way to exercise any of it was to open a browser and look. That
 * found bugs, but slowly, and it could not be repeated on demand: the tab has
 * to be in the foreground for pdf.js to render at all, so a check that depends
 * on the pages being drawn is a check that fails for reasons of its own.
 *
 * So the logic is exercised here instead, against the same markup the templates
 * produce. What is left for a browser is what only a browser can answer:
 * whether it looks right.
 */
export function pageWith(script: string, html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })

  // Some scripts reach for these; jsdom has no layout engine, so they are
  // stubbed rather than left to throw.
  const window = dom.window as unknown as Record<string, unknown>
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = ((fn: () => void) => setTimeout(fn, 0)) as never
  }

  dom.window.eval(readFileSync(`${PUBLIC}${script}`, 'utf8'))
  return dom
}

/**
 * The page grid as pdfpages.js builds it, which is what the range handles and
 * the part badges attach themselves to.
 */
export function pageGrid(count: number): string {
  const tiles = Array.from({ length: count }, (_, index) => {
    const page = index + 1
    return (
      `<li class="pdf-page">` +
      `<button type="button" class="pdf-page-button" data-page="${page}">` +
      `<span class="pdf-page-order" data-pdf-order hidden></span>` +
      `<span class="pdf-page-number">${page}</span>` +
      `</button></li>`
    )
  }).join('')

  return `<ol class="pdf-page-grid" data-pdf-grid>${tiles}</ol>`
}
