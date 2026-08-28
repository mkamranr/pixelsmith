import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pdfToMarkdown } from '../src/tools/pdf-to-markdown.js'
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

interface Line {
  text: string
  size?: number
  gap?: number
}

/**
 * A document built from lines with sizes, since size is what tells a heading
 * from a paragraph in a PDF — there is no other signal in the file.
 */
async function docOf(name: string, pages: Line[][]): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  for (const lines of pages) {
    const page = doc.addPage([420, 600])
    let y = 540
    for (const line of lines) {
      const size = line.size ?? 11
      y -= line.gap ?? 0
      page.drawText(line.text, { x: 50, y, size, font: size > 13 ? bold : font })
      y -= size * 1.6
    }
  }

  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = async (inputs: string[], params: unknown = {}) => {
  const outs = await runTool(pdfToMarkdown, {
    inputs,
    outDir: join(outDir, `m${seq++}`),
    params,
    settings: { allowedRenderHosts: [] } as never,
  })
  return { outs, text: await readFile(outs[0]!.path, 'utf8') }
}

describe('turning a PDF into Markdown', () => {
  it('writes a .md file named after the document', async () => {
    const src = await docOf('notes.pdf', [[{ text: 'Just a line of prose.' }]])

    const { outs } = await run([src])

    expect(outs[0]!.name).toBe('notes.md')
    expect(outs[0]!.mime).toBe('text/markdown')
  })

  it('makes the largest text a heading', async () => {
    const src = await docOf('titled.pdf', [
      [{ text: 'Quarterly Report', size: 22 }, { text: 'Prose follows here.' }],
    ])

    const { text } = await run([src])

    expect(text).toMatch(/^# Quarterly Report$/m)
    expect(text).toMatch(/^Prose follows here\.$/m)
  })

  it('ranks two sizes of heading below the title', async () => {
    const src = await docOf('levels.pdf', [
      [
        { text: 'The Title', size: 24 },
        { text: 'A Section', size: 17 },
        { text: 'Body text under it.' },
        { text: 'A Subsection', size: 14 },
        { text: 'More body text.' },
      ],
    ])

    const { text } = await run([src])

    expect(text).toMatch(/^# The Title$/m)
    expect(text).toMatch(/^## A Section$/m)
    expect(text).toMatch(/^### A Subsection$/m)
  })

  it('joins the lines of a paragraph into one', async () => {
    // A PDF breaks prose wherever the column ended. Keeping those breaks would
    // produce Markdown that re-wraps wrongly everywhere it is rendered.
    const src = await docOf('wrapped.pdf', [
      [
        { text: 'The northern site upgrade finished in June, three' },
        { text: 'weeks behind the original schedule.' },
      ],
    ])

    const { text } = await run([src])

    expect(text).toContain(
      'The northern site upgrade finished in June, three weeks behind the original schedule.',
    )
  })

  it('separates paragraphs that had space between them', async () => {
    const src = await docOf('spaced.pdf', [
      [
        { text: 'First paragraph here.' },
        { text: 'Second paragraph here.', gap: 26 },
      ],
    ])

    const { text } = await run([src])

    expect(text).toMatch(/First paragraph here\.\n\nSecond paragraph here\./)
  })

  it('keeps a bulleted list as a list', async () => {
    const src = await docOf('bullets.pdf', [
      [
        { text: 'Reasons:' },
        { text: '• The first one', gap: 14 },
        { text: '• The second one' },
      ],
    ])

    const { text } = await run([src])

    expect(text).toMatch(/^- The first one$/m)
    expect(text).toMatch(/^- The second one$/m)
  })

  it('keeps a numbered list numbered', async () => {
    const src = await docOf('numbered.pdf', [
      [{ text: '1. Approve the extension', gap: 14 }, { text: '2. Release the funds' }],
    ])

    const { text } = await run([src])

    expect(text).toMatch(/^1\. Approve the extension$/m)
    expect(text).toMatch(/^2\. Release the funds$/m)
  })

  it('escapes text that would otherwise become formatting', async () => {
    // A line of prose containing an asterisk is prose, not emphasis.
    const src = await docOf('specials.pdf', [
      [{ text: 'Costs rose 20% (see note *) and _totals_ shifted.' }],
    ])

    const { text } = await run([src])

    expect(text).toContain('\\*')
    expect(text).toContain('\\_totals\\_')
  })

  it('does not mark page boundaries unless asked', async () => {
    const src = await docOf('two-pages.pdf', [[{ text: 'Page one text.' }], [{ text: 'Page two text.' }]])

    const { text } = await run([src])

    expect(text).not.toContain('---')
    expect(text).toContain('Page one text.')
    expect(text).toContain('Page two text.')
  })

  it('marks them when asked, for a document where the pages matter', async () => {
    const src = await docOf('marked.pdf', [[{ text: 'Page one text.' }], [{ text: 'Page two text.' }]])

    const { text } = await run([src], { pageBreaks: true })

    expect(text).toMatch(/Page one text\.[\s\S]*\n---\n[\s\S]*Page two text\./)
  })

  it('refuses a document with no text rather than writing an empty file', async () => {
    // A scan is images of words, not words. OCR is the answer, and saying so is
    // more use than handing back nothing.
    const blank = await docOf('scanned.pdf', [[]])

    await expect(run([blank])).rejects.toThrow(/no text|OCR/i)
  })
})
