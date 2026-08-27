import { describe, expect, it } from 'vitest'
import { parsePageRanges } from '../src/pages.js'
import { BadInputError } from '../src/errors.js'

describe('parsePageRanges', () => {
  it('reads a single page', () => {
    expect(parsePageRanges('3', 10)).toEqual([3])
  })

  it('reads a comma-separated list', () => {
    expect(parsePageRanges('1,4,7', 10)).toEqual([1, 4, 7])
  })

  it('reads an inclusive range', () => {
    expect(parsePageRanges('2-5', 10)).toEqual([2, 3, 4, 5])
  })

  it('reads an open-ended range as "to the end"', () => {
    expect(parsePageRanges('8-', 10)).toEqual([8, 9, 10])
  })

  it('reads a leading open range as "from the start"', () => {
    expect(parsePageRanges('-3', 10)).toEqual([1, 2, 3])
  })

  it('combines lists and ranges', () => {
    expect(parsePageRanges('1,3-5,9', 10)).toEqual([1, 3, 4, 5, 9])
  })

  it('treats an empty selection as every page', () => {
    expect(parsePageRanges('', 4)).toEqual([1, 2, 3, 4])
    expect(parsePageRanges(undefined, 3)).toEqual([1, 2, 3])
  })

  it('understands the word "all"', () => {
    expect(parsePageRanges('all', 3)).toEqual([1, 2, 3])
  })

  it('tolerates whitespace', () => {
    expect(parsePageRanges(' 1 , 3 - 4 ', 6)).toEqual([1, 3, 4])
  })

  it('keeps the order the user asked for, since that is how pages get reordered', () => {
    expect(parsePageRanges('5,1,3', 6)).toEqual([5, 1, 3])
  })

  it('preserves a deliberate repeat, so a page can be duplicated', () => {
    expect(parsePageRanges('2,2,3', 5)).toEqual([2, 2, 3])
  })

  it('walks a reversed range backwards', () => {
    expect(parsePageRanges('5-3', 6)).toEqual([5, 4, 3])
  })

  it('refuses a page beyond the end of the document', () => {
    expect(() => parsePageRanges('12', 10)).toThrow(BadInputError)
    expect(() => parsePageRanges('8-15', 10)).toThrow(BadInputError)
  })

  it('refuses page zero, since pages are counted from one', () => {
    expect(() => parsePageRanges('0', 10)).toThrow(BadInputError)
  })

  it('refuses text that is not a page selection', () => {
    expect(() => parsePageRanges('first three', 10)).toThrow(BadInputError)
    expect(() => parsePageRanges('1;3', 10)).toThrow(BadInputError)
  })

  it('names the offending part in the error, so the user can fix it', () => {
    expect(() => parsePageRanges('1,abc,3', 10)).toThrow(/abc/)
  })

  it('caps how many pages one selection can name', () => {
    expect(() => parsePageRanges('1-', 100_000)).toThrow(BadInputError)
  })
})
