import { describe, expect, it } from 'vitest'
import { DIFF_LINE_CAP, diffLines } from '../src/diff.js'

/** Compact rendering, so the expectations stay readable. */
const shape = (before: string[], after: string[]) =>
  diffLines(before, after).map((change) => `${change.kind === 'same' ? '=' : change.kind === 'added' ? '+' : '-'}${change.text}`)

describe('diffing lines', () => {
  it('reports nothing changed when the two are identical', () => {
    expect(shape(['one', 'two'], ['one', 'two'])).toEqual(['=one', '=two'])
  })

  it('finds an inserted line', () => {
    expect(shape(['one', 'three'], ['one', 'two', 'three'])).toEqual(['=one', '+two', '=three'])
  })

  it('finds a deleted line', () => {
    expect(shape(['one', 'two', 'three'], ['one', 'three'])).toEqual(['=one', '-two', '=three'])
  })

  it('reports an edited line as the old one going and a new one arriving', () => {
    expect(shape(['total 100'], ['total 250'])).toEqual(['-total 100', '+total 250'])
  })

  it('keeps the original order when changes are scattered', () => {
    expect(shape(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      '=a',
      '-b',
      '+x',
      '=c',
      '=d',
      '+e',
    ])
  })

  it('handles one side being empty', () => {
    expect(shape([], ['new'])).toEqual(['+new'])
    expect(shape(['gone'], [])).toEqual(['-gone'])
    expect(shape([], [])).toEqual([])
  })

  it('does not lose a line when the change is only at the very end', () => {
    expect(shape(['a', 'b'], ['a', 'b', 'c'])).toEqual(['=a', '=b', '+c'])
  })

  it('reports wholesale replacement rather than stalling on enormous inputs', () => {
    /**
     * The comparison is quadratic, so past a cap it stops trying to align lines
     * and says the whole block changed. Reporting that honestly beats spending
     * a gigabyte on a table nobody asked for.
     */
    const before = Array.from({ length: DIFF_LINE_CAP + 50 }, (_, i) => `old ${i}`)
    const after = Array.from({ length: DIFF_LINE_CAP + 50 }, (_, i) => `new ${i}`)
    const changes = diffLines(before, after)

    expect(changes.filter((c) => c.kind === 'removed')).toHaveLength(before.length)
    expect(changes.filter((c) => c.kind === 'added')).toHaveLength(after.length)
  })

  it('still aligns a long document that shares most of its lines', () => {
    // Common prefix and suffix are removed before the quadratic part runs, so a
    // small edit in a long document stays a small diff.
    const shared = Array.from({ length: DIFF_LINE_CAP * 2 }, (_, i) => `line ${i}`)
    const edited = [...shared]
    edited[DIFF_LINE_CAP] = 'line changed'

    const changes = diffLines(shared, edited)
    expect(changes.filter((c) => c.kind !== 'same')).toEqual([
      { kind: 'removed', text: `line ${DIFF_LINE_CAP}` },
      { kind: 'added', text: 'line changed' },
    ])
  })
})
