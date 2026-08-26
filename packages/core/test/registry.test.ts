import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createRegistry,
  InvalidParamsError,
  UnknownToolError,
  UnsupportedInputError,
} from '../src/registry.js'
import type { Tool } from '../src/registry.js'

function makeTool(over: Partial<Tool> = {}): Tool {
  return {
    id: 'shrink',
    title: 'Shrink',
    queue: 'image',
    accepts: ['image/png'],
    params: z.object({ factor: z.number().int().min(2) }),
    ui: { group: 'optimize', icon: 'minimize', fields: [] },
    run: async () => [],
    ...over,
  } as Tool
}

describe('tool registry', () => {
  it('returns a tool registered under its id', () => {
    const reg = createRegistry([makeTool()])
    expect(reg.get('shrink').title).toBe('Shrink')
  })

  it('throws UnknownToolError naming the id that was not found', () => {
    const reg = createRegistry([makeTool()])
    expect(() => reg.get('nope')).toThrow(UnknownToolError)
    expect(() => reg.get('nope')).toThrow(/nope/)
  })

  it('rejects two tools sharing an id, so a typo cannot silently shadow a tool', () => {
    expect(() => createRegistry([makeTool(), makeTool()])).toThrow(/duplicate/i)
  })

  it('lists every registered tool', () => {
    const reg = createRegistry([makeTool(), makeTool({ id: 'grow' })])
    expect(reg.list().map((t) => t.id).sort()).toEqual(['grow', 'shrink'])
  })

  it('parses valid params into a typed value', () => {
    const reg = createRegistry([makeTool()])
    expect(reg.parseParams('shrink', { factor: 4 })).toEqual({ factor: 4 })
  })

  it('throws InvalidParamsError carrying per-field issues for bad params', () => {
    const reg = createRegistry([makeTool()])
    let err: unknown
    try {
      reg.parseParams('shrink', { factor: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidParamsError)
    expect((err as InvalidParamsError).issues[0]).toMatchObject({ path: 'factor' })
  })

  it('coerces missing params to an empty object so paramless tools need no body', () => {
    const reg = createRegistry([makeTool({ id: 'noop', params: z.object({}) })])
    expect(reg.parseParams('noop', undefined)).toEqual({})
  })

  it('rejects an input whose mime type the tool does not accept', () => {
    const reg = createRegistry([makeTool()])
    expect(() => reg.assertAccepts('shrink', 'image/tiff')).toThrow(UnsupportedInputError)
  })

  it('accepts any mime type for a wildcard tool', () => {
    const reg = createRegistry([makeTool({ accepts: ['*'] })])
    expect(() => reg.assertAccepts('shrink', 'image/anything')).not.toThrow()
  })
})
