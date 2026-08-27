import { chmod, mkdir, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { DEFAULT_LIMITS, probeImage, sniffMime, type ProbeLimits } from './probe.js'
import { DEFAULT_PDF_LIMITS, PDF_MIME, probePdf, type PdfLimits } from './pdf.js'
import { InvalidParamsError, LimitExceededError, MalformedPdfError, UnsupportedInputError } from './errors.js'
import {
  DEFAULT_SETTINGS,
  describeAccepts,
  type InputFile,
  type OutputFile,
  type RuntimeSettings,
  type Tool,
} from './registry.js'

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
/**
 * Validate one input against a tool's declared types.
 *
 * Exported and used by both the run gate and the upload route on purpose: when
 * intake validated with one rule and the worker with another, a PDF passed
 * upload and then failed inside the job — and PDFs could not be uploaded at all
 * because intake assumed every file was an image. Two authorities on what is
 * acceptable is one too many.
 */
export async function probeForTool(
  tool: Tool,
  path: string,
  options: { limits?: ProbeLimits; pdfLimits?: PdfLimits } = {},
): Promise<{ mime: string; bytes: number }> {
  const limits = options.limits ?? DEFAULT_LIMITS
  const pdfLimits = options.pdfLimits ?? DEFAULT_PDF_LIMITS
  const sniffed = await sniffMime(path)

  const accepted = tool.accepts.includes('*') || tool.accepts.includes(sniffed)
  if (!accepted) {
    throw new UnsupportedInputError(tool.title, sniffed, describeAccepts(tool))
  }

  if (tool.skipProbe) {
    /**
     * Unlock, Repair and the Office converters exist to handle files the deep
     * check would reject. The cheap guards still apply: the type comes from the
     * bytes and the size limit is enforced. Only the parse is skipped.
     */
    const { size } = await stat(path)
    const ceiling = sniffed === PDF_MIME ? pdfLimits.maxBytes : limits.maxBytes
    if (size === 0) throw new MalformedPdfError('file is empty')
    if (size > ceiling) throw new LimitExceededError('maxBytes', `${size} bytes exceeds ${ceiling}`)
    return { mime: sniffed, bytes: size }
  }

  const probe = sniffed === PDF_MIME ? await probePdf(path, pdfLimits) : await probeImage(path, limits)
  return { mime: probe.mime, bytes: probe.bytes }
}

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
    const probe = await probeForTool(tool, path, { limits, pdfLimits })
    inputs.push({ path, name: displayName, mime: probe.mime, bytes: probe.bytes })
  }

  // Every tool writes here, so create it once rather than trusting thirteen
  // implementations to each remember.
  await mkdir(args.outDir, { recursive: true })

  // Group write, so the inference sidecar's uid can write results here too.
  // Best-effort: if this process does not own the directory then whoever
  // created it already set the mode, and failing the job here would be wrong.
  await chmod(args.outDir, 0o775).catch(() => {})

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
