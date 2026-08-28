import { describe, expect, it } from 'vitest'

import { pageWith } from './helpers/page.js'

/**
 * Placing things on a page. jsdom has no layout, so the page's box is stated
 * rather than measured — the arithmetic that turns a pointer position into a
 * fraction of the page is what matters here, and it is where the bugs are.
 */
function editorPage() {
  const dom = pageWith(
    'pdfitems.js',
    `<form>
       <div class="pdf-page-holder" data-pdf-holder>
         <canvas data-pdf-canvas></canvas>
         <div class="pdf-overlay" data-pdf-overlay></div>
       </div>
       <div class="pdf-items" data-pdf-items>
         <button type="button" data-pdf-add="text">Words</button>
         <button type="button" data-pdf-add="box">Box</button>
         <button type="button" data-pdf-add="highlight">Highlight</button>
         <button type="button" data-pdf-add="image">Picture</button>
         <button type="button" data-pdf-item-colour="red"></button>
         <span data-pdf-items-count></span>
       </div>
       <input type="hidden" name="items" value="">
       <input type="file" name="image">
     </form>`,
  )

  const page = dom.window.document
  const holder = page.querySelector('[data-pdf-holder]') as HTMLElement
  const box = { left: 100, top: 50, width: 400, height: 600 }
  holder.getBoundingClientRect = () =>
    ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => '' })

  const overlay = page.querySelector('[data-pdf-overlay]') as HTMLElement

  return {
    dom,
    page,
    box,
    items: () => {
      const raw = (page.querySelector('[name="items"]') as HTMLInputElement).value
      return raw ? (JSON.parse(raw) as Record<string, unknown>[]) : []
    },
    note: () => page.querySelector('[data-pdf-items-count]')!.textContent,
    drawn: () => overlay.querySelectorAll('[data-pdf-item]').length,
    add(kind: string) {
      ;(page.querySelector(`[data-pdf-add="${kind}"]`) as HTMLElement).click()
    },
    onPage(number: number, pages = 3) {
      page.dispatchEvent(
        new dom.window.CustomEvent('pixelsmith:pdfpage', {
          detail: { page: number, pages, width: box.width, height: box.height },
        }),
      )
    },
    /** Drag the first item, or its resize grip, by a fraction of the page. */
    dragBy(dx: number, dy: number, grip = false) {
      const target = overlay.querySelector(grip ? '[data-pdf-item-grip]' : '[data-pdf-item]')!
      const send = (type: string, fx: number, fy: number) => {
        const event = new dom.window.Event(type, { bubbles: true }) as Event & Record<string, unknown>
        Object.assign(event, {
          clientX: box.left + box.width * fx,
          clientY: box.top + box.height * fy,
          pointerId: 1,
        })
        target.dispatchEvent(event)
      }
      send('pointerdown', 0.5, 0.5)
      send('pointermove', 0.5 + dx, 0.5 + dy)
      send('pointerup', 0.5 + dx, 0.5 + dy)
    },
    removeFirst() {
      ;(overlay.querySelector('[data-pdf-item-drop]') as HTMLElement).click()
    },
  }
}

describe('placing things on a page', () => {
  it('starts with nothing to draw', () => {
    const editor = editorPage()

    expect(editor.items()).toEqual([])
    expect((editor.page.querySelector('[name="items"]') as HTMLInputElement).value).toBe('')
  })

  it('adds words with something legible in them', () => {
    // An empty piece of text is refused by the tool, so the page must not be
    // able to produce one.
    const editor = editorPage()

    editor.add('text')

    expect(editor.items()).toHaveLength(1)
    expect(editor.items()[0]).toMatchObject({ kind: 'text', page: 1 })
    expect(String(editor.items()[0]!.text ?? '')).not.toBe('')
    expect(Number(editor.items()[0]!.size)).toBeGreaterThan(0)
  })

  it('adds a box with a size, which the tool insists on', () => {
    const editor = editorPage()

    editor.add('box')
    const item = editor.items()[0]!

    expect(item.kind).toBe('box')
    expect(Number(item.width)).toBeGreaterThan(0)
    expect(Number(item.height)).toBeGreaterThan(0)
  })

  it('makes a highlight a see-through yellow box, not a third control to set', () => {
    const editor = editorPage()

    editor.add('highlight')
    const item = editor.items()[0]!

    expect(item).toMatchObject({ kind: 'box', colour: 'yellow' })
    expect(Number(item.opacity)).toBeLessThan(1)
  })

  it('refuses to place a picture before one has been chosen', () => {
    // The tool would refuse the job; saying so here saves the round trip.
    const editor = editorPage()

    editor.add('image')

    expect(editor.items()).toEqual([])
    expect(editor.note()).toMatch(/choose a picture/i)
  })

  it('puts what is added on the page being looked at', () => {
    const editor = editorPage()

    editor.onPage(3)
    editor.add('box')

    expect(editor.items()[0]!.page).toBe(3)
  })

  it('shows only the things belonging to the page on screen', () => {
    const editor = editorPage()
    editor.onPage(1)
    editor.add('box')
    editor.onPage(2)
    editor.add('box')

    expect(editor.drawn()).toBe(1)

    editor.onPage(1)
    expect(editor.drawn()).toBe(1)
    expect(editor.items()).toHaveLength(2)
  })

  it('does not stack everything at one spot', () => {
    // Three things added in a row and all in the same place looks like one.
    const editor = editorPage()

    editor.add('box')
    editor.add('box')
    editor.add('box')
    const ys = editor.items().map((item) => Number(item.y))

    expect(new Set(ys).size).toBe(3)
  })

  it('moves a thing by the distance it was dragged', () => {
    const editor = editorPage()
    editor.add('box')
    const before = editor.items()[0]!

    editor.dragBy(0.25, 0.1)
    const after = editor.items()[0]!

    expect(Number(after.x)).toBeCloseTo(Number(before.x) + 0.25, 2)
    expect(Number(after.y)).toBeCloseTo(Number(before.y) + 0.1, 2)
  })

  it('keeps a thing dragged past the edge on the page', () => {
    const editor = editorPage()
    editor.add('box')

    editor.dragBy(-0.9, -0.9)

    expect(Number(editor.items()[0]!.x)).toBe(0)
    expect(Number(editor.items()[0]!.y)).toBe(0)
  })

  it('resizes from the corner', () => {
    const editor = editorPage()
    editor.add('box')
    const before = editor.items()[0]!

    editor.dragBy(0.15, 0.08, true)
    const after = editor.items()[0]!

    expect(Number(after.width)).toBeGreaterThan(Number(before.width))
    expect(Number(after.height)).toBeGreaterThan(Number(before.height))
  })

  it('recolours the selected thing', () => {
    const editor = editorPage()
    editor.add('box')

    ;(editor.page.querySelector('[data-pdf-item-colour="red"]') as HTMLElement).click()

    expect(editor.items()[0]!.colour).toBe('red')
  })

  it('removes a thing, and empties the field when the last one goes', () => {
    const editor = editorPage()
    editor.add('box')

    editor.removeFirst()

    expect(editor.items()).toEqual([])
    expect((editor.page.querySelector('[name="items"]') as HTMLInputElement).value).toBe('')
  })

  it('sends positions as fractions, never as pixels', () => {
    // The page is rendered at whatever the zoom happens to be, so a pixel
    // offset is only true until someone zooms.
    const editor = editorPage()
    editor.add('box')

    const item = editor.items()[0]!
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = Number(item[key])
      expect(value, `${key} looks like pixels`).toBeLessThanOrEqual(1)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})
