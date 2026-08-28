import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openApp, samplePng } from './helpers/app.js'

let h: Awaited<ReturnType<typeof openApp>>

beforeEach(async () => {
  h = await openApp()
})
afterEach(() => h.close())

async function samplePdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 400]).drawText(label, { x: 20, y: 200, size: 18, font })
  return Buffer.from(await doc.save())
}

/**
 * A finished job with the files given, so the results page can be rendered for
 * any combination without needing the tool that would produce it.
 */
async function finishedJob(
  toolId: string,
  files: { role: 'input' | 'output'; name: string; mime: string; body: Buffer }[],
) {
  const owner = await h.ctx.users.createUser({
    email: `results-${Math.random().toString(36).slice(2)}@example.test`,
    name: 'Results',
    password: 'a-sufficiently-long-password',
  })
  const job = await h.ctx.jobs.createJob({ userId: owner.id, toolId, params: {} })
  const paths = await h.ctx.storage.prepare(job.id)

  const rows = []
  for (const f of files) {
    const dir = f.role === 'input' ? paths.inDir : paths.outDir
    const relPath = `${f.role === 'input' ? 'in' : 'out'}/${f.name}`
    await writeFile(join(dir, f.name), f.body)
    rows.push({ role: f.role, name: f.name, relPath, mime: f.mime, bytes: f.body.length })
  }
  await h.ctx.jobs.addFiles(job.id, rows)
  await h.ctx.jobs.markDone(job.id)

  // No cookie here, so the job's own token is the proof — the same rule the
  // API uses.
  const page = await h.app.inject({
    method: 'GET',
    url: `/jobs/${job.id}`,
    headers: { 'x-job-token': job.readToken ?? '' },
  })
  return { job, body: page.body, statusCode: page.statusCode }
}

describe('a result that is a document, not a picture', () => {
  /**
   * Every output was rendered in an <img>. For a PDF that is a broken image
   * icon with the filename as alt text, which is what the results page showed
   * for half the catalogue — and the "before and after" slider above it
   * compared two broken images with a percentage between them.
   */
  it('does not put a PDF in an image tag', async () => {
    const { job, body } = await finishedJob('rotate-pdf', [
      { role: 'input', name: 'in.pdf', mime: 'application/pdf', body: await samplePdf('before') },
      { role: 'output', name: 'out.pdf', mime: 'application/pdf', body: await samplePdf('after') },
    ])

    const imagesPointingAtFiles = [...body.matchAll(/<img[^>]+src="\/jobs\/[^"]+"/g)].map((m) => m[0])

    expect(imagesPointingAtFiles, `job ${job.id} still renders files as images`).toEqual([])
  })

  it('shows the document as a tile a script can turn into a thumbnail', async () => {
    const { body } = await finishedJob('rotate-pdf', [
      { role: 'output', name: 'out.pdf', mime: 'application/pdf', body: await samplePdf('after') },
    ])

    expect(body).toContain('data-doc-tile')
    expect(body).toContain('out.pdf')
  })

  it('still shows a picture as a picture', async () => {
    const { body } = await finishedJob('resize', [
      { role: 'output', name: 'out.png', mime: 'image/png', body: await samplePng() },
    ])

    expect(body).toMatch(/<img[^>]+src="\/jobs\/[^"]+"/)
  })
})

describe('the before and after comparison', () => {
  it('is not offered for documents, which cannot be slid over each other', async () => {
    const { body } = await finishedJob('rotate-pdf', [
      { role: 'input', name: 'in.pdf', mime: 'application/pdf', body: await samplePdf('before') },
      { role: 'output', name: 'out.pdf', mime: 'application/pdf', body: await samplePdf('after') },
    ])

    expect(body).not.toContain('Before and after')
  })

  it('is offered for pictures, where it works', async () => {
    const { body } = await finishedJob('resize', [
      { role: 'input', name: 'in.png', mime: 'image/png', body: await samplePng(200, 150) },
      { role: 'output', name: 'out.png', mime: 'image/png', body: await samplePng(100, 75) },
    ])

    expect(body).toContain('Before and after')
    expect(body).toContain('data-compare')
  })
})

describe('the size difference', () => {
  it('is shown for a tool whose job is to change the size', async () => {
    const { body } = await finishedJob('compress', [
      { role: 'input', name: 'in.png', mime: 'image/png', body: await samplePng(400, 300) },
      { role: 'output', name: 'out.png', mime: 'image/png', body: await samplePng(40, 30) },
    ])

    expect(body).toMatch(/% smaller/)
  })

  it('is not shown for a tool that has no opinion about size', async () => {
    // "0% LARGER" next to a rotated page tells the reader nothing and reads as
    // a fault. Worse on a summary, where "84% SMALLER" invites the thought
    // that the document was compressed.
    const { body } = await finishedJob('rotate', [
      { role: 'input', name: 'in.png', mime: 'image/png', body: await samplePng(400, 300) },
      { role: 'output', name: 'out.png', mime: 'image/png', body: await samplePng(40, 30) },
    ])

    expect(body).not.toMatch(/% smaller|% larger/)
  })
})

describe('comparing two documents', () => {
  /**
   * A report that says "page 3, line removed" is a lookup exercise. Showing the
   * two documents beside each other with the changes marked on them is the
   * point of comparing, so the page hands the viewer both originals and the
   * change list the comparison wrote.
   */
  const compareJob = async () =>
    finishedJob('compare-pdf', [
      { role: 'input', name: 'before.pdf', mime: 'application/pdf', body: await samplePdf('before') },
      { role: 'input', name: 'after.pdf', mime: 'application/pdf', body: await samplePdf('after') },
      { role: 'output', name: 'comparison.pdf', mime: 'application/pdf', body: await samplePdf('report') },
      {
        role: 'output',
        name: 'comparison-changes.json',
        mime: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            before: { name: 'before.pdf', pages: 1 },
            after: { name: 'after.pdf', pages: 1 },
            removed: 1,
            added: 1,
            changes: [
              {
                page: 1,
                side: 'before',
                kind: 'removed',
                text: 'Departed',
                box: { x: 40, y: 60, width: 80, height: 16 },
                pageSize: { width: 300, height: 400 },
              },
            ],
          }),
        ),
      },
    ])

  it('offers the side-by-side view', async () => {
    const { body } = await compareJob()

    expect(body).toContain('data-compare-docs')
    expect(body).toContain('/static/comparedocs.js')
  })

  it('points the view at both originals and the change list', async () => {
    const { body } = await compareJob()

    expect(body).toMatch(/data-compare-before="\/jobs\/[^"]+"/)
    expect(body).toMatch(/data-compare-after="\/jobs\/[^"]+"/)
    expect(body).toMatch(/data-compare-changes="\/jobs\/[^"]+"/)
  })

  it('does not show a machine-readable list as if it were a result to read', async () => {
    // The change list exists for the viewer. Dumping its JSON into the page as
    // a "text result" would be worse than not showing it at all.
    const { body } = await compareJob()

    expect(body).not.toContain('"pageSize"')
  })

  it('leaves other tools alone', async () => {
    const { body } = await finishedJob('rotate-pdf', [
      { role: 'output', name: 'out.pdf', mime: 'application/pdf', body: await samplePdf('after') },
    ])

    expect(body).not.toContain('data-compare-docs')
  })
})

describe('a result that is text', () => {
  it('is readable on the page, without downloading it first', async () => {
    // The point of asking for a summary is to read it. Handing over a file and
    // making the reader open it elsewhere is the whole job left undone.
    const summary = 'The generator failed two of its last four monthly tests.'
    const { body } = await finishedJob('summarise-pdf', [
      { role: 'output', name: 'report-summary.pdf', mime: 'application/pdf', body: await samplePdf('x') },
      { role: 'output', name: 'report-summary.txt', mime: 'text/plain', body: Buffer.from(summary) },
    ])

    expect(body).toContain(summary)
  })

  it('is still offered as a file', async () => {
    const { body } = await finishedJob('summarise-pdf', [
      { role: 'output', name: 'report-summary.txt', mime: 'text/plain', body: Buffer.from('Short.') },
    ])

    expect(body).toContain('report-summary.txt')
  })
})
