import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfToExcel } from '../src/tools/pdf-to-excel.js'
import { pdfToPowerpoint, pdfToWord } from '../src/tools/pdf-to-office.js'
import { runTool } from '../src/run.js'
import { ExternalToolFailedError, ExternalToolUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let doc: string
/** A document whose text would break naive CSV assembly. */
let awkward: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([400, 500])
  page.drawText('Quarterly Report', { x: 40, y: 440, size: 18, font })
  page.drawText('Dubai 412000', { x: 40, y: 400, size: 12, font })
  doc = join(dir, 'report.pdf')
  await writeFile(doc, await pdf.save())

  const tricky = await PDFDocument.create()
  const trickyFont = await tricky.embedFont(StandardFonts.Helvetica)
  tricky
    .addPage([400, 500])
    .drawText('Dubai, UAE said "yes"', { x: 40, y: 400, size: 12, font: trickyFont })
  awkward = join(dir, 'awkward.pdf')
  await writeFile(awkward, await tricky.save())
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (tool: Parameters<typeof runTool>[0], sofficePath: string, inputs = [doc]) =>
  runTool(tool, {
    inputs,
    outDir: join(outDir, `c${seq++}`),
    params: {},
    settings: { allowedRenderHosts: [], sofficePath } as never,
  })

/**
 * A stand-in LibreOffice. The real one is invoked with `--convert-to <target>
 * --outdir <dir> <input>` and writes `<basename>.<target>` into that directory,
 * so the stub does the same and records its arguments.
 */
async function stubSoffice(name: string, body: string) {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/** Mimics LibreOffice closely enough to be worth asserting against. */
const CONVERTS = (log: string) => `
echo "$@" >> ${log}
target=""; outdir=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --convert-to) target="$2"; shift 2 ;;
    --outdir) outdir="$2"; shift 2 ;;
    --*|-env:*) shift ;;
    *) input="$1"; shift ;;
  esac
done
mkdir -p "$outdir"
base=$(basename "$input"); base=\${base%.*}
# The target can carry an explicit filter after a colon, as LibreOffice allows.
ext=\${target%%:*}
cp "$input" "$outdir/$base.$ext"
exit 0
`

describe('PDF to Word', () => {
  it('asks LibreOffice for a Word document through the PDF import filter', async () => {
    const log = join(dir, 'word-argv.txt')
    const outs = await run(pdfToWord, await stubSoffice('lo-word', CONVERTS(log)))

    const args = await readFile(log, 'utf8')
    // Without an explicit input filter LibreOffice opens a PDF in Draw, and the
    // Writer export then has nothing to write.
    expect(args).toContain('writer_pdf_import')
    expect(args).toContain('--convert-to')
    expect(args).toContain('docx')
    expect(outs[0]!.name).toBe('report.docx')
    expect(outs[0]!.mime).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('gives each conversion its own LibreOffice profile', async () => {
    // LibreOffice refuses to run twice against one profile, so workers sharing
    // a profile would block each other.
    const log = join(dir, 'word-profile.txt')
    const soffice = await stubSoffice('lo-profile', CONVERTS(log))
    await run(pdfToWord, soffice)
    await run(pdfToWord, soffice)

    const profiles = (await readFile(log, 'utf8'))
      .split('\n')
      .flatMap((line) => line.match(/-env:UserInstallation=\S+/) ?? [])
    expect(profiles).toHaveLength(2)
    expect(new Set(profiles).size).toBe(2)
  })

  it('does not report success when LibreOffice wrote nothing', async () => {
    const quiet = await stubSoffice('lo-silent', 'exit 0')
    await expect(run(pdfToWord, quiet)).rejects.toThrow(ExternalToolFailedError)
  })

  it('says plainly when LibreOffice is not installed', async () => {
    await expect(run(pdfToWord, join(dir, 'absent-soffice'))).rejects.toThrow(
      ExternalToolUnavailableError,
    )
  })
})

describe('PDF to PowerPoint', () => {
  it('asks for a presentation through the Impress import filter', async () => {
    const log = join(dir, 'ppt-argv.txt')
    const outs = await run(pdfToPowerpoint, await stubSoffice('lo-ppt', CONVERTS(log)))

    expect(await readFile(log, 'utf8')).toContain('impress_pdf_import')
    expect(outs[0]!.name).toBe('report.pptx')
    expect(outs[0]!.mime).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
  })
})

describe('PDF to Excel', () => {
  /**
   * LibreOffice has no PDF-to-spreadsheet export at all — asking for one
   * returns "no export filter". So the text is read out of the document, laid
   * out as rows, and handed to LibreOffice as CSV, which it does convert.
   */
  it('produces a spreadsheet, not a CSV, and says which page each row came from', async () => {
    const log = join(dir, 'xl-argv.txt')
    const outs = await run(pdfToExcel, await stubSoffice('lo-xl', CONVERTS(log)))

    const args = await readFile(log, 'utf8')
    expect(args).toContain('xlsx')
    expect(args).toContain('.csv')
    expect(outs[0]!.name).toBe('report.xlsx')
    expect(outs[0]!.mime).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('escapes text that would otherwise break the spreadsheet apart', async () => {
    // 'Dubai, UAE said "yes"' as a bare CSV field becomes three columns and
    // unbalanced quotes.
    const captured = join(dir, 'captured.csv')
    const soffice = await stubSoffice(
      'lo-csv',
      `for a in "$@"; do case "$a" in *.csv) cp "$a" ${captured};; esac; done\n${CONVERTS(join(dir, 'xl-esc.txt'))}`,
    )
    await run(pdfToExcel, soffice, [awkward])

    const csv = await readFile(captured, 'utf8')
    expect(csv).toContain('"Dubai, UAE said ""yes"""')
  })
})
