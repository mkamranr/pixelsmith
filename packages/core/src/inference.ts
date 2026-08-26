import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
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

/**
 * Run `use` against a copy of the image with its EXIF rotation baked in.
 *
 * A phone stores a portrait photo as landscape pixels plus an orientation flag.
 * Every sharp-based tool resolves that through `openImage()`'s autoOrient, but
 * the inference sidecar reads with OpenCV's IMREAD_UNCHANGED, which ignores the
 * flag — and IMREAD_COLOR, which honours it, discards the alpha channel that
 * background removal exists to produce. So orientation is settled here, on the
 * Node side, keeping one authority over it for the whole app rather than a
 * second implementation in Python that could disagree.
 *
 * An upright image (the overwhelming majority) is passed straight through, so
 * the common case pays nothing for this.
 */
export async function withOrientedCopy<T>(inputPath: string, use: (path: string) => Promise<T>): Promise<T> {
  const meta = await sharp(inputPath).metadata()
  if (!meta.orientation || meta.orientation === 1) {
    return use(inputPath)
  }

  const dir = await mkdtemp(join(tmpdir(), 'pixelsmith-orient-'))
  try {
    // PNG, so nothing is lost re-encoding an intermediate the user never sees.
    const oriented = join(dir, 'oriented.png')
    await sharp(inputPath).autoOrient().png().toFile(oriented)
    return await use(oriented)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
