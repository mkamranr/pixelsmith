import { describe, expect, it } from 'vitest'

import { pageWith } from './helpers/page.js'

/**
 * The fields belong to the document, so the tool cannot declare them. They are
 * read out of the uploaded PDF and announced as an event, which is also how the
 * half that builds the inputs is tested without needing pdf.js or a real file.
 */
function formPage() {
  const dom = pageWith(
    'formfill.js',
    `<form data-canvas-form>
       <input type="file" data-file-input>
       <div class="form-fill" data-form-fill hidden
            data-pdfjs="/static/vendor/pdfjs/pdf.min.mjs"
            data-pdfjs-worker="/static/vendor/pdfjs/pdf.worker.min.mjs">
         <div data-form-fields></div>
         <p data-form-status></p>
       </div>
       <input type="hidden" name="values" value="">
     </form>`,
  )

  const page = dom.window.document

  return {
    dom,
    page,
    values: () => (page.querySelector('[name="values"]') as HTMLInputElement).value,
    answered: () => {
      const raw = (page.querySelector('[name="values"]') as HTMLInputElement).value
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    },
    status: () => page.querySelector('[data-form-status]')!.textContent,
    /** Announce the fields, as reading the document does. */
    offer(fields: unknown[]) {
      page.dispatchEvent(
        new dom.window.CustomEvent('pixelsmith:formfields', { detail: { fields } }),
      )
    },
    control(index: number) {
      const nodes = page.querySelectorAll('[data-form-fields] input, [data-form-fields] select')
      return nodes[index] as HTMLInputElement | HTMLSelectElement
    },
    controls: () =>
      [...page.querySelectorAll('[data-form-fields] input, [data-form-fields] select')].map(
        (node) => node.tagName.toLowerCase() + ':' + ((node as HTMLInputElement).type || 'select'),
      ),
    type(index: number, text: string) {
      const node = this.control(index) as HTMLInputElement
      node.value = text
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    },
    tick(index: number, on = true) {
      const node = this.control(index) as HTMLInputElement
      node.checked = on
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    },
    choose(index: number, option: string) {
      const node = this.control(index) as HTMLSelectElement
      node.value = option
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    },
  }
}

describe("offering a form's own boxes", () => {
  it('makes a control of the right kind for each field', () => {
    const page = formPage()

    page.offer([
      { name: 'applicant', kind: 'text' },
      { name: 'urgent', kind: 'check' },
      { name: 'department', kind: 'choice', options: ['Legal', 'Procurement'] },
    ])

    expect(page.controls()).toEqual(['input:text', 'input:checkbox', 'select:select-one'])
  })

  it('offers only the answers the document accepts', () => {
    // Typing an answer a form cannot take is a mistake worth making impossible
    // rather than reporting after the job fails.
    const page = formPage()

    page.offer([{ name: 'department', kind: 'choice', options: ['Legal', 'Procurement'] }])
    const options = [...page.page.querySelectorAll('option')].map((o) => o.textContent)

    expect(options).toEqual(['—', 'Legal', 'Procurement'])
  })

  it('collects what is typed into the field the tool posts', () => {
    const page = formPage()
    page.offer([{ name: 'applicant', kind: 'text' }])

    page.type(0, 'Kamran Rafi')

    expect(page.answered()).toEqual({ applicant: 'Kamran Rafi' })
  })

  it('sends a ticked box as true and an unticked one not at all', () => {
    // An untouched box is not an answer: saying false would clear a field the
    // form arrived with already ticked.
    const page = formPage()
    page.offer([{ name: 'urgent', kind: 'check' }])

    expect(page.answered()).toEqual({})

    page.tick(0)
    expect(page.answered()).toEqual({ urgent: true })
  })

  it('keeps the answers a form arrived with', () => {
    const page = formPage()

    page.offer([
      { name: 'applicant', kind: 'text', value: 'Existing Name' },
      { name: 'department', kind: 'choice', options: ['Legal'], value: 'Legal' },
    ])

    expect(page.answered()).toEqual({ applicant: 'Existing Name', department: 'Legal' })
    expect((page.control(0) as HTMLInputElement).value).toBe('Existing Name')
  })

  it('does not send an emptied box, which would blank what was there', () => {
    const page = formPage()
    page.offer([{ name: 'applicant', kind: 'text', value: 'Existing Name' }])

    page.type(0, '')

    expect(page.answered()).toEqual({})
  })

  it('counts what has been filled in', () => {
    const page = formPage()
    page.offer([{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }])

    page.type(0, 'one')
    expect(page.status()).toBe('1 box filled')

    page.type(1, 'two')
    expect(page.status()).toBe('2 boxes filled')
  })

  it('says so when the document has no boxes at all', () => {
    const page = formPage()

    page.offer([])

    expect(page.status()).toMatch(/no form fields/i)
    expect(page.values()).toBe('')
  })

  it('replaces the boxes when a different document is chosen', () => {
    // Leaving the previous document's fields on screen would offer answers to
    // a form that is no longer there.
    const page = formPage()
    page.offer([{ name: 'first-form', kind: 'text' }])
    page.type(0, 'typed here')

    page.offer([{ name: 'second-form', kind: 'text' }])

    expect(page.controls()).toEqual(['input:text'])
    expect(page.answered()).toEqual({})
  })

  it('treats a radio group as one choice among its options', () => {
    const page = formPage()

    page.offer([{ name: 'shift', kind: 'radio', options: ['day', 'night'] }])
    page.choose(0, 'night')

    expect(page.answered()).toEqual({ shift: 'night' })
  })
})
