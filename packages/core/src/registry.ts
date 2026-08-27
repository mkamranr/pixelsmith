import { ZodError, type ZodType, type ZodTypeDef } from 'zod'
import { InvalidParamsError, UnknownToolError, UnsupportedInputError } from './errors.js'

export { InvalidParamsError, PixelsmithError, UnknownToolError, UnsupportedInputError } from './errors.js'
export type { ParamIssue } from './errors.js'

/** Which worker pool runs a tool. Kept narrow so a typo is a type error. */
export type QueueName = 'image' | 'render' | 'ml'

/** Declarative form field, rendered by the SPA. No per-tool UI code. */
export interface ToolField {
  name: string
  label: string
  kind: 'number' | 'text' | 'textarea' | 'select' | 'segmented' | 'toggle' | 'color' | 'range' | 'file'
    /**
     * Set by script rather than by hand — a workspace writing back what the
     * user arranged. Declared all the same: the form coercion reads the
     * declared fields, so anything missing here never reaches the tool.
     */
    | 'hidden'
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  help?: string
  /** Show this field only when another field has one of these values. */
  showWhen?: { field: string; equals: unknown[] }
}

export interface ToolUi {
  /** Landing-page grouping: optimize | modify | convert | create | secure */
  group: string
  icon: string
  fields: ToolField[]
  blurb?: string
  /**
   * `form` (default) renders the declarative field list. `editor` marks a tool
   * that needs its own interactive page.
   */
  surface?: 'form' | 'canvas' | 'editor' | 'crop' | 'htmlshot' | 'pdfedit'
  /**
   * How a document is edited on the page itself, rather than by typing numbers
   * into fields. Named after the interaction rather than the tool, because
   * several tools want the same one: `crop` is a single rectangle, `boxes` is
   * any number of them, `place` is a mark dropped where it should sit.
   */
  pdfEdit?: 'crop' | 'boxes' | 'place'
  /**
   * Which PDF workspace suits the tool: a grid of one document's pages, or a
   * card per document. Merging is about the order of files, so a grid of the
   * first upload's pages would be the wrong thing to show.
   */
  pdfView?: 'pages' | 'files'
  /**
   * How the browser should preview this tool's effect on the uploaded
   * thumbnails before anything is submitted. Declared here so the preview logic
   * stays generic instead of switching on tool ids.
   */
  preview?: 'transform' | 'crop' | 'caption' | 'watermark' | 'dimensions' | 'format' | 'none'
}

export interface InputFile {
  path: string
  name: string
  mime: string
  bytes: number
}

export interface OutputFile {
  path: string
  name: string
  mime: string
  bytes: number
  /** Optional findings a tool wants to report, e.g. how many faces it found. */
  meta?: Record<string, unknown>
}

/**
 * Deployment settings a tool may legitimately need. Passed in rather than read
 * from the environment inside a tool, so behaviour is explicit and testable.
 */
export interface RuntimeSettings {
  /**
   * Hosts the HTML renderer may fetch. Empty disables URL rendering entirely,
   * which is the default: on an isolated network an internal URL is often more
   * sensitive than an external one, not less.
   */
  allowedRenderHosts: string[]
  /** Overrides Chromium discovery, for a container that bundles its own. */
  chromiumExecutablePath?: string
  /**
   * Base URL of the inference sidecar. Absent means the machine-learning tools
   * are unavailable and say so, rather than failing obscurely.
   */
  inferenceUrl?: string
  /** Path to qpdf, for the document tools that need it. */
  qpdfPath?: string
  /** Path to the LibreOffice launcher, for Office conversions. */
  sofficePath?: string
  /** Path to tesseract, for optical character recognition. */
  tesseractPath?: string
}

export const DEFAULT_SETTINGS: RuntimeSettings = { allowedRenderHosts: [] }

export interface OpContext<P = unknown> {
  inputs: InputFile[]
  /**
   * Supporting files keyed by form field name, e.g. a watermark logo. Distinct
   * from `inputs`: these are not processed, they are used while processing.
   */
  assets: Record<string, string>
  /** Directory the tool must write its outputs into. Already created. */
  outDir: string
  params: P
  settings: RuntimeSettings
  /** Aborted when the job exceeds its wall-clock budget or is cancelled. */
  signal?: AbortSignal
  /** Report 0..1 completion. Coalesced upstream; call it freely. */
  onProgress?: (fraction: number) => void
}

/** Which menu a tool lives under. Images and PDFs are separate workflows. */
export type ToolFamily = 'image' | 'pdf'

export interface Tool<P = any> {
  id: string
  title: string
  /** Images or PDFs. Required, so a new tool cannot land in neither menu. */
  family: ToolFamily
  queue: QueueName
  /** Accepted input mime types, or `['*']` for any image. */
  accepts: string[]
  /**
   * `files` (the default) takes uploads. `none` marks a tool that generates an
   * image from its parameters alone, so the UI shows no upload control and the
   * route does not require a file.
   */
  inputMode?: 'files' | 'none'
  /**
   * Skip the deep content check for this tool.
   *
   * The probe's job is to refuse encrypted or damaged documents, but Unlock and
   * Repair exist precisely to handle those — being protected from the input
   * would make them impossible. The cheap guards still apply: the type is still
   * sniffed from the bytes and the size limit is still enforced. Only the parse
   * is skipped.
   */
  skipProbe?: boolean
  /** Input type is loose: `.default()` makes fields optional pre-parse. */
  params: ZodType<P, ZodTypeDef, any>
  ui: ToolUi
  run(ctx: OpContext<P>): Promise<OutputFile[]>
}

/** Mime prefixes that make up the Office/OpenDocument family. */
const OFFICE_HINTS = ['officedocument', 'opendocument', 'x-cfb', 'rtf']

/**
 * Describe a tool's accepted input in words a person can act on.
 *
 * "merge-pdf cannot process image/png" is accurate and useless; "Merge PDF
 * works on PDF documents" tells the user what to do instead. Used for the
 * upload control's hint and for the error, so the two always agree.
 */
export function describeAccepts(tool: Tool): string {
  if (tool.inputMode === 'none') return 'no files — it builds one from the settings'

  const kinds: string[] = []
  if (tool.accepts.includes('application/pdf')) kinds.push('PDF documents')
  if (tool.accepts.some((m) => m.startsWith('image/'))) kinds.push('images')
  if (tool.accepts.some((m) => OFFICE_HINTS.some((hint) => m.includes(hint)))) {
    kinds.push('Word, Excel, PowerPoint and OpenDocument files')
  }
  if (kinds.length === 0) return 'files of a supported type'
  if (kinds.length === 1) return kinds[0]!
  return `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`
}

/** The value for a file input's `accept` attribute. */
export function acceptAttribute(tool: Tool): string {
  return tool.accepts.join(',')
}

export interface Registry {
  get(id: string): Tool
  has(id: string): boolean
  list(): Tool[]
  parseParams<P = unknown>(id: string, raw: unknown): P
  assertAccepts(id: string, mime: string): void
}

function toIssues(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

export function createRegistry(tools: Tool[]): Registry {
  const byId = new Map<string, Tool>()
  for (const tool of tools) {
    if (byId.has(tool.id)) {
      throw new Error(`Duplicate tool id registered: ${tool.id}`)
    }
    byId.set(tool.id, tool)
  }

  const get = (id: string): Tool => {
    const tool = byId.get(id)
    if (!tool) throw new UnknownToolError(id)
    return tool
  }

  return {
    get,
    has: (id) => byId.has(id),
    list: () => [...byId.values()],
    parseParams<P>(id: string, raw: unknown): P {
      const tool = get(id)
      // A tool with no required params should accept an absent body.
      const result = tool.params.safeParse(raw ?? {})
      if (!result.success) throw new InvalidParamsError(id, toIssues(result.error))
      return result.data as P
    },
    assertAccepts(id: string, mime: string) {
      const tool = get(id)
      if (tool.accepts.includes('*')) return
      if (!tool.accepts.includes(mime)) throw new UnsupportedInputError(id, mime)
    },
  }
}
