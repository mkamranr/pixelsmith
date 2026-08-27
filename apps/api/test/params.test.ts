import { describe, expect, it } from 'vitest'
import { ALL_TOOLS, registry } from '@pixelsmith/core'
import { coerceFormParams } from '../src/params.js'

/**
 * An HTML form submits every value as a string. A tool that declares a select
 * whose options are really numbers ("90", "180") will therefore fail validation
 * the moment a browser posts it — even though the same tool works fine when a
 * test hands it a real number.
 *
 * These are registry-wide invariants rather than per-tool tests: they hold for
 * every tool that exists now and every tool added later.
 */
describe('form submissions across every tool', () => {
  it('registers at least the Phase 1 tool set', () => {
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(7)
  })

  for (const tool of ALL_TOOLS) {
    describe(tool.id, () => {
      // Both kinds render as a set of fixed string values a browser submits
      // verbatim, so both carry the same coercion risk. Adding a new such kind
      // means adding it here, or it silently drops out of coverage.
      const CHOICE_KINDS = ['select', 'segmented']
      const selects = tool.ui.fields.filter((f) => CHOICE_KINDS.includes(f.kind))

      for (const field of selects) {
        for (const option of field.options ?? []) {
          it(`accepts ${field.name}="${option.value}" (${field.kind}) submitted as a string`, () => {
            // Fill in every other field from its default so we isolate this one.
            const body: Record<string, unknown> = {}
            for (const other of tool.ui.fields) {
              if (other.default !== undefined) body[other.name] = String(other.default)
            }
            body[field.name] = option.value

            const parsed = tool.params.safeParse(coerceFormParams(tool, body))
            const issuesForThisField = parsed.success
              ? []
              : parsed.error.issues.filter((i) => i.path.join('.') === field.name)

            expect(issuesForThisField).toEqual([])
          })
        }
      }

      it('accepts its declared defaults, ignoring fields left blank', () => {
        const body: Record<string, unknown> = {}
        for (const f of tool.ui.fields) {
          if (f.default !== undefined) body[f.name] = String(f.default)
        }
        const coerced = coerceFormParams(tool, body)
        const parsed = tool.params.safeParse(coerced)

        // A tool may legitimately require a value with no sensible default
        // (crop dimensions, a meme caption). What must never happen is a
        // *declared default* being rejected by the tool's own schema.
        const rejectedDefaults = parsed.success
          ? []
          : parsed.error.issues
              .filter((i) => tool.ui.fields.some((f) => f.name === i.path.join('.') && f.default !== undefined))
              .map((i) => `${i.path.join('.')}: ${i.message}`)

        expect(rejectedDefaults).toEqual([])
      })
    })
  }
})

describe('coerceFormParams', () => {
  it('treats an absent checkbox as false, since browsers omit unchecked boxes', () => {
    const tool = registry.get('resize')
    expect(coerceFormParams(tool, { mode: 'pixels', width: '100' })).toMatchObject({ noEnlarge: false })
  })

  it('treats a present checkbox as true', () => {
    const tool = registry.get('resize')
    expect(coerceFormParams(tool, { noEnlarge: 'true' })).toMatchObject({ noEnlarge: true })
  })

  it('converts numeric fields and drops blanks so optional values stay optional', () => {
    const tool = registry.get('resize')
    const out = coerceFormParams(tool, { mode: 'pixels', width: '640', height: '' })
    expect(out.width).toBe(640)
    expect('height' in out).toBe(false)
  })

  it('leaves a non-numeric entry alone so zod can report it rather than silently NaN-ing', () => {
    const tool = registry.get('resize')
    expect(coerceFormParams(tool, { width: 'wide' }).width).toBe('wide')
  })
})

/**
 * The coercion reads the declared UI fields and nothing else, which is what
 * keeps one list of fields instead of two. The catch is that a parameter living
 * only in the zod schema is dropped in silence: merge's per-file rotation was
 * set by the browser, posted, and never arrived.
 */
describe('fields a script sets rather than a person', () => {
  it('carries a hidden field through to the tool', () => {
    const tool = {
      ui: { fields: [{ name: 'rotations', label: 'Rotations', kind: 'hidden' }] },
    } as unknown as Parameters<typeof coerceFormParams>[0]

    expect(coerceFormParams(tool, { rotations: '0,90,0' })).toEqual({ rotations: '0,90,0' })
  })

  it('has merge declare the rotation field, so it is not dropped', () => {
    const declared = registry.get('merge-pdf').ui.fields.map((field) => field.name)
    expect(declared).toContain('rotations')
  })
})
