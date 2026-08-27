import type { Tool } from '@pixelsmith/core'

export interface DocumentedField {
  name: string
  label: string
  kind: string
  required: boolean
  default?: unknown
  min?: number
  max?: number
  options?: { value: string; label: string }[]
  help?: string
}

/**
 * Describe a tool's parameters for the API docs.
 *
 * This reads the tool's declared UI fields rather than introspecting its zod
 * schema. Walking zod internals is brittle across versions, and the fields are
 * the same declaration the form is built from — so docs and form cannot drift.
 */
/**
 * Whether a request without this parameter is refused.
 *
 * Asked of the schema, which is what actually validates the request. It used to
 * be inferred from whether the form field declared a default — a different
 * question with a different answer: a target size has no sensible default and
 * is perfectly optional, and the API was telling every client it was mandatory.
 *
 * The object may be wrapped by a cross-field rule (`.refine`, `.superRefine`),
 * which hides `shape` behind the wrapper, so unwrap before looking.
 */
function isRequired(tool: Tool, name: string): boolean {
  let schema: unknown = tool.params
  // Unwrap ZodEffects and friends until an object with a shape appears.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = schema as { shape?: Record<string, { isOptional?: () => boolean }> }
    if (candidate?.shape) {
      const field = candidate.shape[name]
      return field?.isOptional ? !field.isOptional() : false
    }
    const def = (schema as { _def?: { schema?: unknown; innerType?: unknown } })?._def
    schema = def?.schema ?? def?.innerType
    if (!schema) break
  }
  // Nothing to read: claiming a parameter is required on a guess is the worse
  // of the two mistakes, since it tells a client to send something it cannot.
  return false
}

export function zodToFields(tool: Tool): DocumentedField[] {
  return tool.ui.fields.map((f) => {
    const doc: DocumentedField = {
      name: f.name,
      label: f.label,
      kind: f.kind,
      required: isRequired(tool, f.name),
    }
    if (f.default !== undefined) doc.default = f.default
    if (f.min !== undefined) doc.min = f.min
    if (f.max !== undefined) doc.max = f.max
    if (f.options) doc.options = f.options
    if (f.help) doc.help = f.help
    return doc
  })
}
