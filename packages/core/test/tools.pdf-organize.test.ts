import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { organizePdf } from '../src/tools/pdf-organize.js'
import { extractPdfText } from '../src/pdf-text.js'
import { runTool } from '../src/run.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let seq = 0
let alpha: string
let beta: string

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })
  alpha = await labelled('alpha.pdf', ['A1', 'A2', 'A3'])
  beta = await labelled('beta.pdf', ['B1', 'B2'])
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A document whose pages announce themselves, so an order can be read back. */
async function labelled(name: string, labels: string[]): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const label of labels) {
    doc.addPage([300, 400]).drawText(label, { x: 30, y: 200, size: 36, font })
  }
  const path = join(dir, name)
  await writeFile(path, await doc.save())
  return path
}

const run = (inputs: string[], params: unknown) =>
  runTool(organizePdf, { inputs, outDir: join(outDir, `o${seq++}`), params })

const labelsOf = async (path: string) =>
  (await extractPdfText(path)).map((text) => text.trim())

const anglesOf = async (path: string) => {
  const doc = await PDFDocument.load(await readFile(path))
  return doc.getPageIndices().map((i) => doc.getPage(i).getRotation().angle)
}

const plan = (entries: unknown[]) => JSON.stringify(entries)

/**
 * Organising a stack of paper does not respect which envelope each sheet came
 * in. Several documents go in, one comes out, and the plan says exactly which
 * page goes where — which is a different instruction from a page range, so it
 * is a different parameter rather than a cleverer spelling of the old one.
 */
describe('organising pages across several documents', () => {
  it('builds one document in exactly the order given', async () => {
    const outs = await run([alpha, beta], {
      plan: plan([
        { file: 1, page: 2 },
        { file: 0, page: 3 },
        { file: 1, page: 1 },
      ]),
    })

    expect(outs).toHaveLength(1)
    expect(await labelsOf(outs[0]!.path)).toEqual(['B2', 'A3', 'B1'])
  })

  it('leaves out any page the plan does not mention', async () => {
    const outs = await run([alpha, beta], { plan: plan([{ file: 0, page: 2 }]) })
    expect(await labelsOf(outs[0]!.path)).toEqual(['A2'])
  })

  it('can use a page more than once', async () => {
    const outs = await run([alpha], {
      plan: plan([{ file: 0, page: 1 }, { file: 0, page: 1 }]),
    })
    expect(await labelsOf(outs[0]!.path)).toEqual(['A1', 'A1'])
  })

  it('turns the pages it is told to, and only those', async () => {
    const outs = await run([alpha], {
      plan: plan([
        { file: 0, page: 1, rotate: 90 },
        { file: 0, page: 2 },
        { file: 0, page: 3, rotate: 180 },
      ]),
    })
    expect(await anglesOf(outs[0]!.path)).toEqual([90, 0, 180])
  })

  it('adds a turn to one the page already had', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([300, 400]).setRotation(degrees(90))
    const sideways = join(dir, 'sideways.pdf')
    await writeFile(sideways, await doc.save())

    const outs = await run([sideways], { plan: plan([{ file: 0, page: 1, rotate: 90 }]) })
    expect(await anglesOf(outs[0]!.path)).toEqual([180])
  })

  it('names the trouble when the plan points at a document that is not there', async () => {
    await expect(run([alpha], { plan: plan([{ file: 3, page: 1 }]) })).rejects.toThrow(/document/i)
  })

  it('names the trouble when the plan points past the end of a document', async () => {
    await expect(run([alpha], { plan: plan([{ file: 0, page: 9 }]) })).rejects.toThrow(/9/)
  })

  it('refuses an angle that is not a quarter turn', () => {
    expect(organizePdf.params.safeParse({ plan: plan([{ file: 0, page: 1, rotate: 45 }]) }).success)
      .toBe(false)
  })

  it('still reorders a single document from a page list, with no script involved', async () => {
    const outs = await run([alpha], { pages: '3,1' })

    expect(outs).toHaveLength(1)
    expect(await labelsOf(outs[0]!.path)).toEqual(['A3', 'A1'])
  })

  it('insists on being told something to do', () => {
    expect(organizePdf.params.safeParse({}).success).toBe(false)
    expect(organizePdf.params.safeParse({ pages: '1' }).success).toBe(true)
    expect(organizePdf.params.safeParse({ plan: plan([{ file: 0, page: 1 }]) }).success).toBe(true)
  })
})
