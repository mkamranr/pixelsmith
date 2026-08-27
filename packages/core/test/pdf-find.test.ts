import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findTextBoxes } from '../src/pdf-find.js'
import * as fx from './helpers/fixtures.js'

let dir: string
const PAGE = { width: 595, height: 842 }
const SIZE = 20

beforeAll(async () => {
  dir = await fx.scratchDir()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** Draw the given lines at known positions, so a box can be checked against them. */
async function pdfWith(
  name: string,
  pages: { text: string; x: number; y: number }[][],
): Promise<{ path: string; widthOf: (text: string) => number }> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)

  for (const lines of pages) {
    const page = doc.addPage([PAGE.width, PAGE.height])
    for (const line of lines) {
      page.drawText(line.text, { x: line.x, y: line.y, size: SIZE, font })
    }
  }

  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return { path, widthOf: (text: string) => font.widthOfTextAtSize(text, SIZE) }
}

describe('finding text to redact', () => {
  it('boxes a phrase where it actually sits on the page', async () => {
    /**
     * The box has to cover the words. Checked against where they were drawn
     * rather than against a remembered figure: a box that is merely "about
     * right" leaves a sliver of a name showing.
     */
    const { path, widthOf } = await pdfWith('find-one.pdf', [[{ text: 'SECRET', x: 100, y: 700 }]])
    const boxes = await findTextBoxes(path, { terms: ['SECRET'] })

    expect(boxes).toHaveLength(1)
    const box = boxes[0]!
    expect(box.page).toBe(1)

    const left = box.x * PAGE.width
    const right = (box.x + box.width) * PAGE.width
    const top = box.y * PAGE.height
    const bottom = (box.y + box.height) * PAGE.height

    expect(left).toBeLessThanOrEqual(101)
    expect(right).toBeGreaterThanOrEqual(100 + widthOf('SECRET') - 1)
    // Drawn on a baseline at y=700, so the glyphs occupy roughly 700..720 from
    // the bottom, which is 122..142 from the top.
    expect(top).toBeLessThanOrEqual(124)
    expect(bottom).toBeGreaterThanOrEqual(140)
  })

  it('ignores the case of the phrase', async () => {
    const { path } = await pdfWith('find-case.pdf', [[{ text: 'Confidential', x: 60, y: 600 }]])
    expect(await findTextBoxes(path, { terms: ['CONFIDENTIAL'] })).toHaveLength(1)
  })

  it('finds every occurrence, on whichever page', async () => {
    const { path } = await pdfWith('find-many.pdf', [
      [{ text: 'Ahmed here', x: 60, y: 700 }, { text: 'and Ahmed again', x: 60, y: 600 }],
      [{ text: 'no mention', x: 60, y: 700 }],
      [{ text: 'Ahmed once more', x: 60, y: 500 }],
    ])
    const boxes = await findTextBoxes(path, { terms: ['Ahmed'] })

    expect(boxes).toHaveLength(3)
    expect(boxes.map((b) => b.page)).toEqual([1, 1, 3])
  })

  it('returns nothing when the phrase is absent', async () => {
    const { path } = await pdfWith('find-none.pdf', [[{ text: 'nothing to see', x: 60, y: 700 }]])
    expect(await findTextBoxes(path, { terms: ['absent'] })).toEqual([])
  })

  it('finds an email address without being told what it is', async () => {
    const { path } = await pdfWith('find-mail.pdf', [
      [{ text: 'write to a.nadir@example.test today', x: 60, y: 700 }],
    ])
    const boxes = await findTextBoxes(path, { patterns: ['email'] })

    expect(boxes).toHaveLength(1)
    // The address only, not the whole line.
    expect(boxes[0]!.width).toBeLessThan(0.6)
  })

  it('finds a card number and is not fooled by a number that is not one', async () => {
    /**
     * Checked with Luhn rather than by counting digits: a bare "sixteen digits"
     * rule marks invoice references and order numbers as card numbers, and a
     * redaction tool that cries wolf gets switched off.
     */
    const valid = await pdfWith('find-card.pdf', [[{ text: 'card 4111 1111 1111 1111', x: 40, y: 700 }]])
    expect(await findTextBoxes(valid.path, { patterns: ['card'] })).toHaveLength(1)

    const invalid = await pdfWith('find-notcard.pdf', [[{ text: 'ref 1234 5678 9012 3456', x: 40, y: 700 }]])
    expect(await findTextBoxes(invalid.path, { patterns: ['card'] })).toEqual([])
  })

  it('finds a telephone number but not any short run of digits', async () => {
    const { path } = await pdfWith('find-phone.pdf', [
      [{ text: 'call +971 4 555 1234 now', x: 40, y: 700 }, { text: 'page 12 of 40', x: 40, y: 600 }],
    ])
    const boxes = await findTextBoxes(path, { patterns: ['phone'] })
    expect(boxes).toHaveLength(1)
  })

  it('can be told to cover a little more than the glyphs', async () => {
    const { path } = await pdfWith('find-pad.pdf', [[{ text: 'SECRET', x: 100, y: 700 }]])
    const tight = await findTextBoxes(path, { terms: ['SECRET'] })
    const padded = await findTextBoxes(path, { terms: ['SECRET'], padding: 0.5 })

    expect(padded[0]!.width).toBeGreaterThan(tight[0]!.width)
    expect(padded[0]!.height).toBeGreaterThan(tight[0]!.height)
    expect(padded[0]!.x).toBeLessThan(tight[0]!.x)
  })

  it('matches a phrase that the document split across pieces', async () => {
    // Generators break lines into runs freely; a phrase spanning two of them is
    // still the phrase.
    const { path } = await pdfWith('find-split.pdf', [
      [{ text: 'Ahmed', x: 60, y: 700 }, { text: 'Nadir', x: 130, y: 700 }],
    ])
    const boxes = await findTextBoxes(path, { terms: ['Ahmed Nadir'] })

    expect(boxes).toHaveLength(1)
    // Spans both runs.
    expect(boxes[0]!.width * 595).toBeGreaterThan(110)
  })
})
