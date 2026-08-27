import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfProtect } from '../src/tools/pdf-protect.js'
import { pdfUnlock } from '../src/tools/pdf-unlock.js'
import { pdfRepair } from '../src/tools/pdf-repair.js'
import { runTool } from '../src/run.js'
import { ExternalToolFailedError, ExternalToolUnavailableError } from '../src/errors.js'
import * as fx from './helpers/fixtures.js'

let dir: string
let outDir: string
let doc: string
let seq = 0

beforeAll(async () => {
  dir = await fx.scratchDir()
  outDir = join(dir, 'out')
  await mkdir(outDir, { recursive: true })

  const pdf = await PDFDocument.create()
  pdf.addPage([300, 400])
  doc = join(dir, 'plain.pdf')
  await writeFile(doc, await pdf.save())
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const run = (tool: Parameters<typeof runTool>[0], params: unknown, qpdfPath: string, inputs = [doc]) =>
  runTool(tool, {
    inputs,
    outDir: join(outDir, `s${seq++}`),
    params,
    settings: { allowedRenderHosts: [], qpdfPath } as never,
  })

/**
 * A stand-in qpdf that records how it was invoked. `$@` is the argument list as
 * the process actually received it, which is what a test needs to prove a
 * password never reached argv.
 */
async function stubQpdf(name: string, body: string) {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

const ARGV_LOG = () => join(dir, `argv-${seq}.txt`)

describe('protect a PDF with a password', () => {
  it('insists on a password', () => {
    expect(pdfProtect.params.safeParse({}).success).toBe(false)
    expect(pdfProtect.params.safeParse({ password: 'short' }).success).toBe(false)
    expect(pdfProtect.params.safeParse({ password: 'a-good-long-password' }).success).toBe(true)
  })

  it('never puts the password in the process arguments', async () => {
    // Anyone on the host can read `ps`. A password in argv is a password
    // leaked to every other user on the machine.
    const log = ARGV_LOG()
    const qpdf = await stubQpdf('q-argv', `echo "$@" > ${log}\ncp "$2" "$3" 2>/dev/null || true\nexit 0`)
    await run(pdfProtect, { password: 'super-secret-passphrase' }, qpdf).catch(() => {})

    const argv = await readFile(log, 'utf8')
    expect(argv).not.toContain('super-secret-passphrase')
  })

  it('passes the settings through an argument file instead', async () => {
    const captured = join(dir, 'captured.txt')
    // The stub resolves the @argfile and copies its contents out for inspection.
    const qpdf = await stubQpdf(
      'q-argfile',
      `for a in "$@"; do case "$a" in @*) cat "\${a#@}" > ${captured};; esac; done\nexit 0`,
    )
    await run(pdfProtect, { password: 'another-long-secret', allowPrinting: false }, qpdf).catch(() => {})

    const argfile = await readFile(captured, 'utf8')
    expect(argfile).toContain('--encrypt')
    expect(argfile).toContain('another-long-secret')
    expect(argfile).toContain('--print=none')
  })

  it('leaves no argument file behind, since it held a password', async () => {
    const qpdf = await stubQpdf('q-clean', 'exit 0')
    const before = (await readdir(dir)).length
    await run(pdfProtect, { password: 'yet-another-secret-one' }, qpdf).catch(() => {})
    const after = await readdir(dir)
    // No stray temp file added to the working area.
    expect(after.length).toBeLessThanOrEqual(before + 1)
    expect(after.some((f) => f.includes('qpdf-args'))).toBe(false)
  })

  it('says plainly when qpdf is not installed', async () => {
    await expect(
      run(pdfProtect, { password: 'a-good-long-password' }, join(dir, 'absent-qpdf')),
    ).rejects.toThrow(ExternalToolUnavailableError)
  })
})

describe('unlock a PDF', () => {
  it('insists on the current password', () => {
    expect(pdfUnlock.params.safeParse({}).success).toBe(false)
    expect(pdfUnlock.params.safeParse({ password: 'x' }).success).toBe(true)
  })

  it('keeps the password out of the process arguments', async () => {
    const log = join(dir, 'unlock-argv.txt')
    const qpdf = await stubQpdf('q-unlock', `echo "$@" > ${log}\nexit 0`)
    await run(pdfUnlock, { password: 'the-existing-password' }, qpdf).catch(() => {})
    expect(await readFile(log, 'utf8')).not.toContain('the-existing-password')
  })

  it('explains a wrong password in words a user can act on', async () => {
    const qpdf = await stubQpdf('q-wrongpw', 'echo "qpdf: invalid password" >&2\nexit 2')
    const failure = await run(pdfUnlock, { password: 'not-the-password' }, qpdf).catch((e) => e as Error)
    expect(failure).toBeInstanceOf(ExternalToolFailedError)
    expect(failure.message).toMatch(/password/i)
  })
})

describe('repair a PDF', () => {
  it('runs qpdf over the document', async () => {
    const log = join(dir, 'repair-argv.txt')
    const qpdf = await stubQpdf('q-repair', `echo "$@" > ${log}\ncp "$1" "$2"\nexit 0`)
    const outs = await run(pdfRepair, {}, qpdf)
    expect(outs).toHaveLength(1)
    expect(outs[0]!.mime).toBe('application/pdf')
  })

  it('accepts qpdf reporting recoverable damage, which is the whole point', async () => {
    // Exit 3 means "rebuilt it, but the input had problems" — success here.
    const qpdf = await stubQpdf('q-repair-warn', 'cp "$1" "$2"\necho "file is damaged" >&2\nexit 3')
    const outs = await run(pdfRepair, {}, qpdf)
    expect(outs).toHaveLength(1)
  })

  it('still fails on damage it cannot recover', async () => {
    const qpdf = await stubQpdf('q-repair-dead', 'echo "unable to find trailer" >&2\nexit 2')
    await expect(run(pdfRepair, {}, qpdf)).rejects.toThrow(ExternalToolFailedError)
  })
})

/**
 * The encryption arguments are a grammar, not a bag of flags, and qpdf changed
 * that grammar mid-11.x: `--user-password=` and `--bits=` only exist from 11.7.
 * Debian bookworm — the base image this ships on — carries 11.3.0, which needs
 * the positional `--encrypt user owner key-length ... --` form. That form is
 * accepted by every version, so it is the portable one.
 *
 * The stub below refuses the newer spellings exactly as 11.3 does, so these
 * tests fail if anyone reaches for them again. `toContain` assertions cannot
 * catch this: a wrong grammar still contains the right substrings.
 */
describe('qpdf encryption arguments are portable to the pinned qpdf', () => {
  const QPDF_11_3_PARSER = (log: string) => `
args=""
for a in "$@"; do
  case "$a" in
    @*) while IFS= read -r line; do args="$args
$line"; done < "\${a#@}" ;;
    *) args="$args
$a" ;;
  esac
done
printf '%s' "$args" > ${log}
# qpdf 11.3 knows neither of these spellings and exits 2 on an unknown argument.
if printf '%s' "$args" | grep -qE -- '--user-password=|--owner-password=|--bits='; then
  echo "qpdf: unrecognized argument" >&2
  exit 2
fi
# Real qpdf writes an output file; the last two tokens are input then output.
clean=$(printf '%s\n' "$args" | sed '/^$/d')
cp "$(printf '%s' "$clean" | tail -2 | head -1)" "$(printf '%s' "$clean" | tail -1)"
exit 0
`

  it('is accepted by a qpdf 11.3 argument parser', async () => {
    const log = join(dir, 'enc-113.txt')
    const qpdf = await stubQpdf('q-113', QPDF_11_3_PARSER(log))
    await expect(run(pdfProtect, { password: 'a-good-long-password' }, qpdf)).resolves.toBeDefined()
  })

  it('gives the password, owner password and key length positionally', async () => {
    const log = join(dir, 'enc-order.txt')
    const qpdf = await stubQpdf('q-order', QPDF_11_3_PARSER(log))
    await run(pdfProtect, { password: 'a-good-long-password', allowPrinting: false }, qpdf)

    const tokens = (await readFile(log, 'utf8')).split('\n').filter((t) => t.length > 0)
    const at = tokens.indexOf('--encrypt')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(tokens.slice(at + 1, at + 4)).toEqual([
      'a-good-long-password',
      'a-good-long-password',
      '256',
    ])
    // Options belong between the key length and the terminating `--`.
    const end = tokens.indexOf('--', at)
    expect(tokens.slice(at + 4, end)).toContain('--print=none')
    expect(end).toBeGreaterThan(at + 4)
  })
})
