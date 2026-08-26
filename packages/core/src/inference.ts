import { InferenceFailedError, InferenceUnavailableError, BadInputError } from './errors.js'
import type { RuntimeSettings } from './registry.js'

/** Model work is slow on CPU; a 4x upscale of a large photo can take minutes. */
export const DEFAULT_INFERENCE_TIMEOUT_MS = 180_000

/**
 * Client for the inference sidecar.
 *
 * The sidecar reads and writes the shared job volume, so only paths cross this
 * boundary — never image bytes. That keeps a 200MB TIFF from being serialised
 * through two HTTP stacks for no reason.
 */
export async function callInference<T>(
  settings: RuntimeSettings,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_INFERENCE_TIMEOUT_MS,
): Promise<T> {
  const base = settings.inferenceUrl
  if (!base) {
    throw new InferenceUnavailableError(
      'no inference service is configured on this server, so the AI tools are switched off',
    )
  }

  let response: Response
  try {
    response = await fetch(new URL(endpoint, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // A sidecar that is down, starting up, or wedged all land here.
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
    throw new InferenceUnavailableError(`the inference service at ${base} ${reason}`)
  }

  if (!response.ok) {
    const detail = await readDetail(response)
    // Distinguish "this capability is missing" from "your input was bad" from
    // everything else, so the job records something a user can act on.
    if (response.status === 503) throw new InferenceUnavailableError(detail)
    if (response.status === 422 || response.status === 400) throw new BadInputError(detail)
    throw new InferenceFailedError(detail)
  }

  return (await response.json()) as T
}

async function readDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return body.detail
    return JSON.stringify(body)
  } catch {
    return `the service replied ${response.status}`
  }
}
