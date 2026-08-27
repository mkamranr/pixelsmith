import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { DEFAULT_LIMITS, probeImage, sniffMime, type ProbeLimits } from './probe.js'
import { DEFAULT_PDF_LIMITS, PDF_MIME, probePdf, type PdfLimits } from './pdf.js'
import { InvalidParamsError, UnsupportedInputError } from './errors.js'
import { DEFAULT_SETTINGS, type InputFile, type OutputFile, type RuntimeSettings, type Tool } from './registry.js'

/** A staged input: where it lives on disk, and what to call the result. */
export interface RunToolInput {
  path: string
  /** Display name shown to the user. Defaults to the file's own basename. */
  name?: string
}

export interface RunToolArgs {
  /**
   * Staged input files. Pass `{path, name}` when the on-disk name differs from
   * the name the user should see — uploads are stored with a uniquifying prefix.
   */
  inputs: (string | RunToolInput)[]
  outDir: string
  params?: unknown
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  limits?: ProbeLimits
  pdfLimits?: PdfLimits
  settings?: RuntimeSettings
  /** Supporting files keyed by field name (absolute paths). */
  assets?: Record<string, string>
}

/**
 * The one path by which a tool is ever executed — used by the worker and by
 * tests alike, so what the suite exercises is what production runs.
 *
 * Every input is probed and vetted here rather than inside each tool. Thirteen
 * tools each remembering to check their own inputs is thirteen chances to
 * forget; doing it once at the gate is how the guarantee actually holds.
 */
export async function runTool(tool: Tool, args: RunToolArgs): Promise<OutputFile[]> {
  const limits = args.limits ?? DEFAULT_LIMITS
  const pdfLimits = args.pdfLimits ?? DEFAULT_PDF_LIMITS
  // safeParse, so bad params surface as a typed InvalidParamsError with field
  // detail rather than a raw ZodError the caller has to interpret.
  const parsed = tool.params.safeParse(args.params ?? {})
  if (!parsed.success) {
    throw new InvalidParamsError(
      tool.id,
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  const params = parsed.data

  const inputs: InputFile[] = []
  for (const entry of args.inputs) {
    const path = typeof entry === 'string' ? entry : entry.path
    const displayName = (typeof entry === 'string' ? undefined : entry.name) ?? basename(path)

    /**
     * Validate against the rules for what the file actually is. A PDF is a
     * container with an object graph, not a raster: it needs page-count and
     * encryption checks where an image needs pixel and decompression-bomb ones.
     */
    const sniffed = await sniffMime(path)
    const probe = sniffed === PDF_MIME ? await probePdf(path, pdfLimits) : await probeImage(path, limits)

    if (!tool.accepts.includes('*') && !tool.accepts.includes(probe.mime)) {
      throw new UnsupportedInputError(tool.id, probe.mime)
    }
    inputs.push({ path, name: displayName, mime: probe.mime, bytes: probe.bytes })
  }

  // Every tool writes here, so create it once rather than trusting thirteen
  // implementations to each remember.
  await mkdir(args.outDir, { recursive: true })

  return tool.run({
    inputs,
    outDir: args.outDir,
    params,
    assets: args.assets ?? {},
    settings: args.settings ?? DEFAULT_SETTINGS,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
  })
}
