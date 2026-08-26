import type { Tool } from '@pixelsmith/core'

/**
 * HTML forms submit everything as strings, and unchecked boxes not at all.
 * Coerce a form body into the shape a tool's zod schema expects, using the
 * field kinds the tool already declares for its UI — so there is no second
 * place to keep in sync.
 */
export function coerceFormParams(tool: Tool, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const field of tool.ui.fields) {
    const raw = body[field.name]

    if (field.kind === 'toggle') {
      // An unchecked checkbox is simply absent from the submission.
      out[field.name] = raw !== undefined && raw !== 'false' && raw !== 'off'
      continue
    }

    if (raw === undefined || raw === '' || raw === null) continue

    if (field.kind === 'number' || field.kind === 'range') {
      const n = Number(raw)
      // Leave a non-numeric value in place so zod reports it, rather than
      // silently turning a typo into NaN or dropping the field.
      out[field.name] = Number.isFinite(n) ? n : raw
      continue
    }

    out[field.name] = raw
  }

  return out
}
