import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { officeToPdf } from '../src/tools/office-to-pdf.js'
import { runTool } from '../src/run.js'
import { ExternalToolFailedError, ExternalToolUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

const run_ = promisify(execFile)

let dir: string
let outDir: string
let docx: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  // A real, minimal .docx, so the type is detected from its bytes as it would
  // be in production rather than assumed from the extension.
  const build = join(dir, 'build')
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Report</w:t></w:r></w:p></w:body></w:document>',
  }
  for (const [name, body] of Object.entries(parts)) {
    const full = join(build, name)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  docx = join(dir, 'report.docx')
  await run_('zip', ['-r', '-X', docx, '[Content_Types].xml', '_rels', 'word'], { cwd: build })
}, 60_000)

afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (params: unknown, sofficePath: string, inputs = [docx]) =>
  runTool(officeToPdf, {
    inputs,
    outDir: join(outDir, `o${seq++}`),
    params,
    settings: { allowedRenderHosts: [], sofficePath } as never,
  })

/** A stand-in LibreOffice. Arguments arrive in a fixed order, so it can use them. */
async function stubSoffice(name: string, body: string) {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

describe('Office documents to PDF', () => {
  it('accepts Word, Excel and PowerPoint by their real types', () => {
    expect(officeToPdf.family).toBe('pdf')
    expect(officeToPdf.accepts).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(officeToPdf.accepts).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(officeToPdf.accepts).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('does not accept a PDF, which is the other direction', () => {
    expect(officeToPdf.accepts).not.toContain('application/pdf')
  })

  it('converts a document and names the result as a PDF', async () => {
    const soffice = await stubSoffice(
      'so-ok',
      'mkdir -p "$6"\nbase=$(basename "$7")\nprintf "%%PDF-1.7 stub" > "$6/${base%.*}.pdf"',
    )
    const [out] = await run({}, soffice)
    expect(out!.name).toBe('report.pdf')
    expect(out!.mime).toBe('application/pdf')
    expect(out!.bytes).toBeGreaterThan(0)
  })

  it('gives every run its own LibreOffice profile', async () => {
    // Two conversions sharing one profile directory collide, which is how
    // parallel workers deadlock each other.
    const log = join(dir, 'profiles.txt')
    const soffice = await stubSoffice(
      'so-profile',
      `echo "$2" >> ${log}\nmkdir -p "$6"\nbase=$(basename "$7")\nprintf "%%PDF-1.7" > "$6/\${base%.*}.pdf"`,
    )
    await run({}, soffice)
    await run({}, soffice)

    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^-env:UserInstallation=file:\/\/\//)
    expect(lines[0]).not.toBe(lines[1])
  })

  it('says plainly when LibreOffice is not installed', async () => {
    await expect(run({}, join(dir, 'absent-soffice'))).rejects.toThrow(ExternalToolUnavailableError)
  })

  it('names LibreOffice in the message, so an operator knows what is missing', async () => {
    const failure = await run({}, join(dir, 'absent')).catch((e) => e as Error)
    expect(failure.message).toMatch(/libreoffice/i)
  })

  it('reports a conversion failure rather than returning nothing', async () => {
    const soffice = await stubSoffice('so-fail', 'echo "Error: source file could not be loaded" >&2\nexit 1')
    const failure = await run({}, soffice).catch((e) => e as Error)
    expect(failure).toBeInstanceOf(ExternalToolFailedError)
    expect(failure.message).toMatch(/could not be loaded/)
  })

  it('fails clearly if LibreOffice claims success but writes nothing', async () => {
    // It does exactly this on some malformed inputs, and a silent empty result
    // would otherwise reach the user as a finished job with no file.
    const soffice = await stubSoffice('so-empty', 'exit 0')
    const failure = await run({}, soffice).catch((e) => e as Error)
    expect(failure.message).toMatch(/did not produce|no output/i)
  })
})
