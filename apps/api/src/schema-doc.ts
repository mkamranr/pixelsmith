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
export function zodToFields(tool: Tool): DocumentedField[] {
  return tool.ui.fields.map((f) => {
    const doc: DocumentedField = {
      name: f.name,
      label: f.label,
      kind: f.kind,
      required: f.default === undefined && f.kind !== 'toggle',
    }
    if (f.default !== undefined) doc.default = f.default
    if (f.min !== undefined) doc.min = f.min
    if (f.max !== undefined) doc.max = f.max
    if (f.options) doc.options = f.options
    if (f.help) doc.help = f.help
    return doc
  })
}
