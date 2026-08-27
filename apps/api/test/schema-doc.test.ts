import { registry } from '@pixelsmith/core'
import { describe, expect, it } from 'vitest'

import { zodToFields } from '../src/schema-doc.js'

/**
 * What the API says about a parameter is what a client writes its code
 * against, so "required" has to mean what it says: the request fails without
 * it. It was inferred from whether the form field declared a default, which is
 * a different question — a field can perfectly well have no default and be
 * optional, and several do.
 */
const fieldsOf = (toolId: string) => {
  const byName = new Map(zodToFields(registry.get(toolId)).map((f) => [f.name, f]))
  return byName
}

describe('what the API says a parameter needs', () => {
  it('does not demand a parameter the tool is happy without', () => {
    // Compress works with no target size at all: quality is chosen for you.
    // It has no default because there is nothing sensible to put there.
    expect(fieldsOf('compress').get('targetKb')?.required).toBe(false)
  })

  it('demands the ones a job genuinely cannot run without', () => {
    const crop = fieldsOf('crop')

    expect(crop.get('width')?.required).toBe(true)
    expect(crop.get('height')?.required).toBe(true)
  })

  it('treats a parameter with a default as optional', () => {
    expect(fieldsOf('compress').get('level')?.required).toBe(false)
  })

  it('reads through a schema that carries cross-field rules', () => {
    // blur-faces refines its object to refuse a job that would obscure
    // nothing. That wraps the object, and the parameters have to stay legible
    // through the wrapper.
    const blur = fieldsOf('blur-faces')

    expect(blur.get('regions')?.required).toBe(false)
    expect(blur.get('method')?.required).toBe(false)
  })

  it('agrees with the schema for every tool, which is the only real authority', () => {
    // Anything the documentation calls required must actually be refused when
    // absent, and anything it calls optional must actually be accepted.
    const disagreements: string[] = []

    for (const tool of registry.list()) {
      for (const field of zodToFields(tool)) {
        const withoutIt = tool.params.safeParse({})
        const complained =
          !withoutIt.success &&
          withoutIt.error.issues.some((i) => i.path[0] === field.name && i.code === 'invalid_type')
        if (complained !== field.required) {
          disagreements.push(`${tool.id}.${field.name}: says ${field.required}, schema says ${complained}`)
        }
      }
    }

    expect(disagreements).toEqual([])
  })
})
