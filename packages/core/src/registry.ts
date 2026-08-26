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
  kind: 'number' | 'text' | 'textarea' | 'select' | 'toggle' | 'color' | 'range' | 'file'
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
  surface?: 'form' | 'editor'
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
}

export const DEFAULT_SETTINGS: RuntimeSettings = { allowedRenderHosts: [] }

export interface OpContext<P = unknown> {
  inputs: InputFile[]
  /** Directory the tool must write its outputs into. Already created. */
  outDir: string
  params: P
  settings: RuntimeSettings
  /** Aborted when the job exceeds its wall-clock budget or is cancelled. */
  signal?: AbortSignal
  /** Report 0..1 completion. Coalesced upstream; call it freely. */
  onProgress?: (fraction: number) => void
}

export interface Tool<P = any> {
  id: string
  title: string
  queue: QueueName
  /** Accepted input mime types, or `['*']` for any image. */
  accepts: string[]
  /**
   * `files` (the default) takes uploads. `none` marks a tool that generates an
   * image from its parameters alone, so the UI shows no upload control and the
   * route does not require a file.
   */
  inputMode?: 'files' | 'none'
  /** Input type is loose: `.default()` makes fields optional pre-parse. */
  params: ZodType<P, ZodTypeDef, any>
  ui: ToolUi
  run(ctx: OpContext<P>): Promise<OutputFile[]>
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
