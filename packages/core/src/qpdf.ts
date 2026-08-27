import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExternal } from './external.js'
import type { RuntimeSettings } from './registry.js'

/**
 * qpdf's exit codes: 0 is success, 3 means it did the work but found
 * recoverable problems in the input. Treating 3 as failure would reject most
 * real-world documents, which are rarely perfectly formed.
 */
const SUCCESS_CODES = [0, 3]

/**
 * Run qpdf with arguments that may contain a password.
 *
 * Passwords are written to a temporary argument file rather than passed on the
 * command line, because argv is world-readable through `ps`: a password there
 * is a password disclosed to every other user on the host. The file is created
 * with owner-only permissions in a private directory and removed immediately
 * afterwards, whether the command succeeded or not.
 */
export async function runQpdfWithSecrets(
  settings: RuntimeSettings,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const command = settings.qpdfPath ?? 'qpdf'
  const dir = await mkdtemp(join(tmpdir(), 'pixelsmith-qpdf-'))
  const argFile = join(dir, 'args')

  try {
    // One argument per line is qpdf's @file format.
    await writeFile(argFile, `${args.join('\n')}\n`, { mode: 0o600 })
    await chmod(argFile, 0o600)

    await runExternal('qpdf', command, [`@${argFile}`], {
      successCodes: SUCCESS_CODES,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Run qpdf with arguments that hold nothing sensitive. */
export async function runQpdf(
  settings: RuntimeSettings,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await runExternal('qpdf', settings.qpdfPath ?? 'qpdf', args, {
    successCodes: SUCCESS_CODES,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
}
