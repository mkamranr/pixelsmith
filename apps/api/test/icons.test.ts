import { fileURLToPath } from 'node:url'

import { ALL_TOOLS } from '@pixelsmith/core'
import nunjucks from 'nunjucks'
import { describe, expect, it } from 'vitest'

/**
 * A tool declares the icon it wants by name, and the macro draws it. Nothing
 * connects the two, so a new tool naming an icon the macro has never heard of
 * falls through to the generic mark at the end — a bare circle, which in a menu
 * of drawn icons reads as a missing one. That is how several tools shipped
 * looking iconless: not blank, which would have been obvious, but featureless.
 */
const VIEWS = fileURLToPath(new URL('../src/views', import.meta.url))
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(VIEWS), { autoescape: true })

const render = (name: string): string =>
  env.renderString(`{% import "_icons.njk" as ic %}{{ ic.icon(name) }}`, { name })

/**
 * What the macro draws for a name it does not know. Comparing against this
 * rather than against an empty string is the whole point: the fallback renders
 * a perfectly valid SVG, so only knowing what it looks like reveals the gap.
 */
const FALLBACK = render('no-icon-is-named-this')

describe('the icon every tool asks for', () => {
  it('is drawn for all of them, not left as the generic mark', () => {
    const fellThrough = ALL_TOOLS.filter((tool) => render(tool.ui.icon) === FALLBACK).map(
      (tool) => `${tool.id} asks for '${tool.ui.icon}'`,
    )

    expect(fellThrough).toEqual([])
  })

  it('is distinct enough to tell two tools apart', () => {
    // Not one icon per tool — related tools sharing a mark is deliberate. But a
    // single icon standing in for half the catalogue means the menu reads as a
    // wall of sameness, which is the failure this guards against.
    const byIcon = new Map<string, string[]>()
    for (const tool of ALL_TOOLS) {
      byIcon.set(tool.ui.icon, [...(byIcon.get(tool.ui.icon) ?? []), tool.id])
    }
    const overused = [...byIcon].filter(([, ids]) => ids.length > 4)

    expect(overused).toEqual([])
  })
})
