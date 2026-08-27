import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { ExternalToolFailedError, ExternalToolUnavailableError } from './errors.js'

/**
 * Running a bundled command-line tool.
 *
 * Some document work genuinely needs a native binary — qpdf for encryption,
 * LibreOffice for Office formats. Each is reached through this one seam so the
 * behaviour is uniform: a missing binary is reported as a capability that is
 * not installed (503) rather than a crash, a failing binary is reported with
 * its own message, and nothing runs without a wall-clock limit.
 *
 * Arguments are always passed as an array, never as a shell string, so a
 * filename can never be interpreted as a command.
 */
export interface ExternalOptions {
  timeoutMs?: number
  /** Exit codes to treat as success. qpdf uses 3 for "worked, with warnings". */
  successCodes?: number[]
  maxOutputBytes?: number
}

export interface ExternalResult {
  code: number
  stdout: string
  stderr: string
}

const DEFAULT_TIMEOUT_MS = 120_000

/** Is this command present and executable? */
export async function isExecutable(command: string): Promise<boolean> {
  try {
    await access(command, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function runExternal(
  tool: string,
  command: string,
  args: string[],
  options: ExternalOptions = {},
): Promise<ExternalResult> {
  if (command.includes('/') && !(await isExecutable(command))) {
    throw new ExternalToolUnavailableError(tool, `${command} is missing or not executable`)
  }

  const successCodes = options.successCodes ?? [0]

  return new Promise<ExternalResult>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxOutputBytes ?? 4 * 1024 * 1024,
        // No shell: arguments stay arguments, whatever a filename contains.
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')

        if (!error) return resolve({ code: 0, stdout: out, stderr: err })

        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
        if (successCodes.includes(code)) return resolve({ code, stdout: out, stderr: err })

        // ENOENT means the command does not exist at all.
        if ((error as { code?: string }).code === 'ENOENT') {
          return reject(new ExternalToolUnavailableError(tool, `${command} was not found`))
        }
        if ((error as { killed?: boolean }).killed) {
          return reject(new ExternalToolFailedError(tool, 'it took too long and was stopped'))
        }

        const detail = (err || out || error.message).trim().split('\n').slice(0, 3).join(' ')
        return reject(new ExternalToolFailedError(tool, detail || `exited with code ${code}`))
      },
    )
  })
}
