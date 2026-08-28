import { describe, expect, it } from 'vitest'

import { pageWith, stageFile } from './helpers/page.js'

/**
 * Nine positions is nine answers to a question with infinitely many. The mark
 * on the preview is now the handle, and dragging it writes the coordinates the
 * tool takes — the same coordinates the PDF watermark has used for a while.
 *
 * jsdom has no layout, so the picture's box is stated rather than measured.
 * That is the part a browser answers; what is checked here is the arithmetic
 * that turns a pointer position into a fraction of the image, which is where
 * the bugs live.
 */
function watermarkPage() {
  const dom = pageWith(
    'canvas.js',
    `<form data-canvas-form data-preview="watermark">
       <input type="file" data-file-input>
       <div data-stage></div>
       <div class="canvas-view" data-view hidden>
         <div class="canvas-plate" data-plate><img data-canvas-image alt=""></div>
         <span data-canvas-name></span><span data-canvas-sizes></span>
       </div>
       <div data-nav hidden><select data-nav-select></select></div>
       <button type="button" data-add-more hidden></button>
       <button type="button" data-remove-current hidden></button>
       <p data-summary></p>
       <input name="text" value="CONFIDENTIAL">
       <input name="color" value="#ffffff">
       <input name="opacity" value="45">
       <input type="hidden" name="x" value="">
       <input type="hidden" name="y" value="">
       <input type="hidden" name="position" value="bottom-right">
       <input type="checkbox" name="tiled">
     </form>`,
  )

  const { document: page, window } = dom.window as unknown as {
    document: Document
    window: Window & typeof globalThis
  }

  // A 400×300 picture at (100, 50) in the plate, since jsdom measures nothing.
  const box = { left: 100, top: 50, width: 400, height: 300, right: 500, bottom: 350 }
  const image = page.querySelector('[data-canvas-image]') as HTMLElement
  const plate = page.querySelector('[data-plate]') as HTMLElement
  image.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, toJSON: () => '' })
  plate.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => '',
  })

  return {
    dom,
    page,
    box,
    x: () => (page.querySelector('[name="x"]') as HTMLInputElement).value,
    y: () => (page.querySelector('[name="y"]') as HTMLInputElement).value,
    mark: () => page.querySelector('[data-mark-drag]') as HTMLElement | null,
    /** Stage a picture, then draw the preview as any change would. */
    draw() {
      stageFile(dom)
      page.querySelector('form')!.dispatchEvent(new window.Event('change', { bubbles: true }))
    },
    dragTo(clientX: number, clientY: number) {
      const mark = this.mark()
      if (!mark) throw new Error('no mark to drag')
      const at = (type: string, extra: Record<string, unknown> = {}) => {
        const event = new window.Event(type, { bubbles: true }) as Event & Record<string, unknown>
        Object.assign(event, { clientX, clientY, pointerId: 1, ...extra })
        mark.dispatchEvent(event)
      }
      at('pointerdown', { clientX: box.left + 380, clientY: box.top + 280 })
      at('pointermove')
      at('pointerup')
    },
  }
}

describe('moving a watermark by dragging it', () => {
  it('puts a handle on the mark once there is a picture', () => {
    const page = watermarkPage()
    page.draw()

    expect(page.mark()).not.toBeNull()
    expect(page.mark()!.classList.contains('is-draggable')).toBe(true)
  })

  it('writes where it was dropped, as a fraction of the picture', () => {
    const page = watermarkPage()
    page.draw()

    // A quarter across, a third down.
    page.dragTo(page.box.left + 100, page.box.top + 100)

    expect(Number(page.x())).toBeCloseTo(0.25, 2)
    expect(Number(page.y())).toBeCloseTo(0.3333, 2)
  })

  it('keeps a drag past the edge inside the picture', () => {
    // Dropping outside is a thing people do; a coordinate outside is a thing
    // the tool refuses. Clamping here means the gesture never produces one.
    const page = watermarkPage()
    page.draw()

    page.dragTo(page.box.left - 500, page.box.top + 900)

    expect(Number(page.x())).toBe(0)
    expect(Number(page.y())).toBe(1)
  })

  it('leaves the coordinates empty until something is dragged', () => {
    // Untouched, the nine presets still decide — so an existing choice of
    // "bottom right" is not silently overridden by a coordinate nobody set.
    const page = watermarkPage()
    page.draw()

    expect(page.x()).toBe('')
    expect(page.y()).toBe('')
  })

  it('announces the change once, at the end of the drag', () => {
    // Every intermediate position is noise to anything else on the form.
    const page = watermarkPage()
    page.draw()
    let announced = 0
    page.page.querySelector('[name="x"]')!.addEventListener('change', () => {
      announced += 1
    })

    page.dragTo(page.box.left + 200, page.box.top + 150)

    expect(announced).toBe(1)
  })
})
