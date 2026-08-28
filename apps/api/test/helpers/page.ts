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

  /**
   * jsdom has no layout engine and no object URLs, and the scripts reach for
   * both. Stubbed rather than left to throw, because what is under test is the
   * arithmetic, not the browser.
   */
  const window = dom.window as unknown as Record<string, unknown>
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = ((fn: () => void) => setTimeout(fn, 0)) as never
  }
  const url = dom.window.URL as unknown as Record<string, unknown>
  if (!url.createObjectURL) {
    let issued = 0
    url.createObjectURL = (() => `blob:stub/${(issued += 1)}`) as never
    url.revokeObjectURL = (() => undefined) as never
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

/**
 * Stage a file the way choosing one does, so the scripts that only act once
 * there is something to act on will run.
 *
 * The bytes are irrelevant: nothing here decodes an image, and the size a
 * picture is drawn at is stated by the test rather than measured.
 */
export function stageFile(dom: JSDOM, name = 'sample.png', type = 'image/png') {
  const input = dom.window.document.querySelector('[data-file-input]') as HTMLInputElement | null
  if (!input) throw new Error('no file input on this page')

  const file = new dom.window.File([new Uint8Array([1, 2, 3])], name, { type })

  // jsdom has no DataTransfer, so the list is defined on the input directly.
  // The scripts read `files` and iterate it; the ones that write it back guard
  // for DataTransfer being absent already, because a browser without it is a
  // browser where staging cannot be improved on.
  const list = { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) }
  Object.defineProperty(input, 'files', { value: list, configurable: true })

  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  return file
}
