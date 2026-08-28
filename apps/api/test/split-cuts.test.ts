import { describe, expect, it } from 'vitest'

import { pageGrid, pageWith } from './helpers/page.js'

/**
 * Splitting asked for ranges as text — `1-6,10-12` — which requires knowing the
 * page numbers before you can say anything at all. The page grid is right
 * there; a cut belongs between two pages on it.
 */
function splitPage(pages: number, ranges = '') {
  const dom = pageWith(
    'pdfranges.js',
    `<form>
       <div class="field" data-field="ranges">
         <input name="ranges" value="${ranges}">
       </div>
       <div class="range-rows" data-range-rows hidden></div>
       ${pageGrid(pages)}
     </form>`,
  )

  const document_ = dom.window.document
  const field = document_.querySelector('[name="ranges"]') as HTMLInputElement

  return {
    dom,
    field,
    /** Tell the script how many pages there are, as pdfpages.js does. */
    announce(count: number) {
      document_.dispatchEvent(new dom.window.CustomEvent('pixelsmith:pages', { detail: count }))
    },
    handles(): number[] {
      return [...document_.querySelectorAll('[data-cut]')].map((node) =>
        Number(node.getAttribute('data-cut')),
      )
    },
    cutHandles(): number[] {
      return [...document_.querySelectorAll('[data-cut].is-cut')].map((node) =>
        Number(node.getAttribute('data-cut')),
      )
    },
    cut(page: number) {
      const handle = document_.querySelector(`[data-cut="${page}"]`) as HTMLButtonElement | null
      if (!handle) throw new Error(`no handle before page ${page}`)
      handle.click()
    },
    /** The part number shown on each page tile, or null where none is shown. */
    badges(): (number | null)[] {
      return [...document_.querySelectorAll('[data-page]')].map((tile) => {
        const badge = tile.querySelector('[data-pdf-order]') as HTMLElement | null
        return badge && !badge.hidden ? Number(badge.textContent) : null
      })
    },
  }
}

describe('cutting a document between two pages', () => {
  it('offers a handle before every page but the first', () => {
    // Page one always begins the first part; there is nothing before it to cut.
    const page = splitPage(5)
    page.announce(5)

    expect(page.handles()).toEqual([2, 3, 4, 5])
  })

  it('turns one cut into two parts covering the whole document', () => {
    const page = splitPage(10)
    page.announce(10)

    page.cut(4)

    expect(page.field.value).toBe('1-3,4-10')
  })

  it('turns two cuts into three parts, in page order however they were made', () => {
    const page = splitPage(10)
    page.announce(10)

    page.cut(8)
    page.cut(4)

    expect(page.field.value).toBe('1-3,4-7,8-10')
  })

  it('takes a cut back when its handle is used again', () => {
    const page = splitPage(10)
    page.announce(10)

    page.cut(4)
    page.cut(8)
    page.cut(4)

    expect(page.field.value).toBe('1-7,8-10')
  })

  it('returns to one whole part when the last cut is taken back', () => {
    const page = splitPage(6)
    page.announce(6)

    page.cut(3)
    page.cut(3)

    expect(page.field.value).toBe('1-6')
  })

  it('marks the handles that are cutting', () => {
    const page = splitPage(9)
    page.announce(9)

    page.cut(3)
    page.cut(7)

    expect(page.cutHandles()).toEqual([3, 7])
  })

  it('numbers each page with the part it lands in', () => {
    // The point of cutting on the grid: which part a page ends up in is visible
    // rather than worked out from the syntax.
    const page = splitPage(6)
    page.announce(6)

    page.cut(3)
    page.cut(5)

    expect(page.badges()).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('starts from ranges that were already typed', () => {
    // Someone who typed the value should find the handles agreeing with it,
    // not a blank grid contradicting the field.
    const page = splitPage(12, '1-4,5-9,10-12')
    page.announce(12)

    expect(page.cutHandles()).toEqual([5, 10])
  })

  it('leaves the field alone until something is actually cut', () => {
    const page = splitPage(8, '2-5')
    page.announce(8)

    expect(page.field.value).toBe('2-5')
  })

  it('ignores a cut beyond the end of the document', () => {
    const page = splitPage(4)
    page.announce(4)

    // No handle exists past the last page, so asking for one is a test error
    // rather than a thing a person could do.
    expect(() => page.cut(9)).toThrow(/no handle/)
    expect(page.field.value).toBe('1-4')
  })
})
