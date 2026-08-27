import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExternalToolFailedError } from './errors.js'
import { runExternal } from './external.js'
import type { RuntimeSettings } from './registry.js'

/** LibreOffice can hang on a malformed document; it does not get forever. */
const CONVERT_TIMEOUT_MS = 180_000

export interface LibreOfficeTarget {
  /** What to ask for: `pdf`, `docx`, or a target carrying an explicit filter. */
  target: string
  /** Extension of the file LibreOffice will write, used to find it afterwards. */
  extension: string
  /**
   * Input filter. Without one LibreOffice opens a PDF in Draw, and a Writer or
   * Calc export then has nothing to write.
   */
  infilter?: string
  timeoutMs?: number
}

/**
 * Run one LibreOffice conversion and put the result at `dest`.
 *
 * Every conversion gets a private profile directory. LibreOffice keeps a single
 * user profile and refuses to run twice against it, so parallel workers sharing
 * one would block each other.
 */
export async function convertWithLibreOffice(
  settings: RuntimeSettings,
  input: string,
  dest: string,
  target: LibreOfficeTarget,
): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'pixelsmith-soffice-'))
  const profile = join(work, 'profile')
  const produced = join(work, 'out')

  try {
    await runExternal(
      'LibreOffice',
      settings.sofficePath ?? 'soffice',
      [
        '--headless',
        `-env:UserInstallation=file://${profile}`,
        // One token: the filter name contains spaces, and there is no shell here
        // to split it.
        ...(target.infilter ? [`--infilter=${target.infilter}`] : []),
        '--convert-to',
        target.target,
        '--outdir',
        produced,
        input,
      ],
      { timeoutMs: target.timeoutMs ?? CONVERT_TIMEOUT_MS },
    )

    /**
     * LibreOffice sometimes exits successfully having written nothing at all.
     * Left unchecked that reaches the user as a finished job with no file,
     * which is worse than an error.
     */
    const suffix = `.${target.extension.toLowerCase()}`
    const written = (await readdir(produced).catch(() => [])).filter((name) =>
      name.toLowerCase().endsWith(suffix),
    )
    if (written.length === 0) {
      throw new ExternalToolFailedError(
        'LibreOffice',
        `it reported success but did not produce a ${target.extension.toUpperCase()} file, which usually means the document could not be read`,
      )
    }

    await copyFile(join(produced, written[0]!), dest)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
