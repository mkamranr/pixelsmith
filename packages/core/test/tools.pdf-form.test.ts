import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { extractPdfText } from '../src/pdf-text.js'
import { loadPdf } from '../src/pdf.js'
import { fillForm } from '../src/tools/pdf-form.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A form with one of each kind of field, which is what a real one has. */
async function formPdf(name: string): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([420, 600])
  const form = doc.getForm()

  const applicant = form.createTextField('applicant')
  applicant.setText('')
  applicant.addToPage(page, { x: 40, y: 520, width: 260, height: 22, font })

  const department = form.createDropdown('department')
  department.setOptions(['Infrastructure', 'Procurement', 'Legal'])
  department.addToPage(page, { x: 40, y: 470, width: 260, height: 22, font })

  const urgent = form.createCheckBox('urgent')
  urgent.addToPage(page, { x: 40, y: 430, width: 16, height: 16 })

  const shift = form.createRadioGroup('shift')
  shift.addOptionToPage('day', page, { x: 40, y: 390, width: 16, height: 16 })
  shift.addOptionToPage('night', page, { x: 90, y: 390, width: 16, height: 16 })

  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

/** A document with no form at all. */
async function plainPdf(name: string): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 400]).drawText('No form here.', { x: 40, y: 200, size: 12, font })
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], params: unknown) =>
  runTool(fillForm, {
    inputs,
    outDir: join(outDir, `f${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })

const values = (map: Record<string, unknown>) => ({ values: JSON.stringify(map) })

describe('filling in a PDF form', () => {
  it('puts typed text into a text field', async () => {
    const src = await formPdf('typed.pdf')

    const [out] = await run([src], values({ applicant: 'Kamran Rafi' }))

    expect((await extractPdfText(out!.path)).join(' ')).toContain('Kamran Rafi')
  })

  it('chooses an option in a dropdown', async () => {
    const src = await formPdf('chosen.pdf')

    const [out] = await run([src], values({ department: 'Procurement' }))

    expect((await extractPdfText(out!.path)).join(' ')).toContain('Procurement')
  })

  it('refuses an option the dropdown does not offer', async () => {
    // Writing it in anyway would produce a form saying something the form was
    // never able to say.
    const src = await formPdf('bad-option.pdf')

    await expect(run([src], values({ department: 'Catering' }))).rejects.toThrow(/Catering|option/i)
  })

  it('ticks a checkbox, and leaves it alone when told false', async () => {
    const src = await formPdf('ticked.pdf')

    // Read back through the form, so the answers have to survive as fields —
    // which means not flattening them away first.
    const ticked = await run([src], { ...values({ urgent: true }), flatten: false })
    const clear = await run([src], { ...values({ urgent: false, applicant: 'A' }), flatten: false })

    const fieldOf = async (path: string) => {
      const form = (await loadPdf(path)).getForm()
      return form.getCheckBox('urgent').isChecked()
    }

    expect(await fieldOf(ticked[0]!.path)).toBe(true)
    expect(await fieldOf(clear[0]!.path)).toBe(false)
  })

  it('picks one of a set of radio options', async () => {
    const src = await formPdf('radio.pdf')

    const [out] = await run([src], { ...values({ shift: 'night' }), flatten: false })
    const form = (await loadPdf(out!.path)).getForm()

    expect(form.getRadioGroup('shift').getSelected()).toBe('night')
  })

  it('flattens by default, so the answers cannot be altered', async () => {
    // The usual reason for filling a form is to send it. A recipient who can
    // edit the answers has been sent a draft, not a completed form.
    const src = await formPdf('flat.pdf')

    const [out] = await run([src], values({ applicant: 'Kamran Rafi' }))
    const form = (await loadPdf(out!.path)).getForm()

    expect(form.getFields()).toHaveLength(0)
    expect((await extractPdfText(out!.path)).join(' ')).toContain('Kamran Rafi')
  })

  it('leaves the form fillable when asked to', async () => {
    const src = await formPdf('still-editable.pdf')

    const [out] = await run([src], { ...values({ applicant: 'Kamran Rafi' }), flatten: false })
    const form = (await loadPdf(out!.path)).getForm()

    expect(form.getFields().length).toBeGreaterThan(0)
    expect(form.getTextField('applicant').getText()).toBe('Kamran Rafi')
  })

  it('says which fields it found, so a page can offer them', async () => {
    const src = await formPdf('listed.pdf')

    const [out] = await run([src], values({ applicant: 'A' }))

    expect(out!.meta).toMatchObject({ fields: 4, filled: 1 })
  })

  it('refuses a field the form does not have, rather than ignoring it', async () => {
    // A typo that silently does nothing produces a form that looks filled and
    // is not.
    const src = await formPdf('typo.pdf')

    await expect(run([src], values({ aplicant: 'Kamran Rafi' }))).rejects.toThrow(/aplicant/)
  })

  it('says plainly when the document has no form in it', async () => {
    const src = await plainPdf('formless.pdf')

    await expect(run([src], values({ anything: 'x' }))).rejects.toThrow(/no form|no fields/i)
  })

  it('refuses values that are not readable as a set of answers', async () => {
    const src = await formPdf('garbled.pdf')

    await expect(run([src], { values: 'not json at all' })).rejects.toThrow(/could not be read/i)
  })

  it('insists on being given something to fill in', async () => {
    expect(fillForm.params.safeParse({}).success).toBe(false)
    expect(fillForm.params.safeParse({ values: '{}' }).success).toBe(true)
  })
})
