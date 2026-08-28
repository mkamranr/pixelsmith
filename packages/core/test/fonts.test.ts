import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { HANDWRITING_FACES, handwritingFace, registerHandwritingFaces } from '../src/fonts.js'
import { preparePdfText } from '../src/pdf-draw-text.js'

const FONT_DIR = fileURLToPath(new URL('../../../assets/vendor/fonts', import.meta.url))

/**
 * The faces are build inputs, fetched by infra/bundle/fetch-assets.sh against
 * pinned checksums, and deliberately not committed. A checkout that has not
 * fetched them yet still has to be able to run the suite, so the tests that
 * need the actual files say so rather than failing for the wrong reason.
 */
const present = existsSync(`${FONT_DIR}/GreatVibes-Regular.ttf`)

describe('the handwriting faces on offer', () => {
  it('names each one with a family and a file', () => {
    for (const [id, face] of Object.entries(HANDWRITING_FACES)) {
      expect(face.family, `${id} has no family`).toBeTruthy()
      expect(face.file, `${id} has no file`).toMatch(/\.ttf$/)
      expect(face.label, `${id} has no label`).toBeTruthy()
    }
  })

  it('offers more than one, so the choice is a choice', () => {
    expect(Object.keys(HANDWRITING_FACES).length).toBeGreaterThan(2)
  })

  it('does not resolve a face it has never heard of', () => {
    expect(handwritingFace('copperplate-gothic')).toBeUndefined()
  })
})

describe.skipIf(!present)('registering them', () => {
  it('makes each family available to draw with', () => {
    const registered = registerHandwritingFaces(FONT_DIR)

    for (const face of Object.values(HANDWRITING_FACES)) {
      expect(registered, `${face.family} did not register`).toContain(face.family)
    }
  })

  it('can be called twice without complaint, because a worker restarts', () => {
    expect(() => {
      registerHandwritingFaces(FONT_DIR)
      registerHandwritingFaces(FONT_DIR)
    }).not.toThrow()
  })

  it('says nothing registered when the directory is not there', () => {
    // An image built without the assets fetched. The tools that need a face
    // should find none and fall back, not crash the worker at start-up.
    expect(registerHandwritingFaces('/nowhere/at/all')).toEqual([])
  })
})

describe.skipIf(!present)('setting a name in a handwriting face', () => {
  const write = async (family?: string) => {
    registerHandwritingFaces(FONT_DIR)
    const doc = await PDFDocument.create()
    return preparePdfText(doc, { text: 'Kamran Rafi', size: 48, ...(family ? { family } : {}) })
  }

  it('is not the same as setting it in the default face', async () => {
    // The whole point. If the family were ignored, these would measure alike —
    // which is exactly how a silently-ignored font announces itself.
    const plain = await write()
    const script = await write(HANDWRITING_FACES['great-vibes']!.family)

    expect(script.width).toBeGreaterThan(0)
    expect(Math.abs(script.width - plain.width)).toBeGreaterThan(2)
  })

  it('differs between one face and another', async () => {
    const formal = await write(HANDWRITING_FACES['great-vibes']!.family)
    const flowing = await write(HANDWRITING_FACES['dancing-script']!.family)

    expect(Math.abs(formal.width - flowing.width)).toBeGreaterThan(2)
  })

  it('arrives as a drawn mark rather than selectable text', async () => {
    // A handwriting face is not one of the PDF standard fonts, so it cannot be
    // drawn as text. The mark says so rather than pretending.
    const script = await write(HANDWRITING_FACES.caveat!.family)

    expect(script.selectable).toBe(false)
  })

  it('still produces something for a name the face has no glyphs for', async () => {
    // An Arabic name in a Latin-only handwriting face. Better a legible
    // fallback than an exception at signing time.
    const arabic = await write(HANDWRITING_FACES['great-vibes']!.family)
    const doc = await PDFDocument.create()
    const mark = await preparePdfText(doc, {
      text: 'كامران رافي',
      size: 48,
      family: HANDWRITING_FACES['great-vibes']!.family,
    })

    expect(arabic.width).toBeGreaterThan(0)
    expect(mark.width).toBeGreaterThan(0)
  })
})
