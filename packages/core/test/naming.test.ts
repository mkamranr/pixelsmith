import { describe, expect, it } from 'vitest'
import { deriveName, stem, uniqueName } from '../src/naming.js'

describe('deriveName', () => {
  it('keeps the stem and swaps the extension', () => {
    expect(deriveName('holiday.png', { ext: 'jpg' })).toBe('holiday.jpg')
  })

  it('appends a suffix before the extension', () => {
    expect(deriveName('holiday.png', { suffix: '-small' })).toBe('holiday-small.png')
  })

  it('discards any directory component, so a crafted filename cannot steer writes', () => {
    expect(deriveName('../../etc/passwd.png')).toBe('passwd.png')
    expect(deriveName('a/b/c.png')).toBe('c.png')
  })

  it('falls back to a placeholder when a name has no usable stem', () => {
    expect(deriveName('.png')).toBe('image.png')
  })

  it('lowercases the extension', () => {
    expect(deriveName('SHOUT.PNG')).toBe('SHOUT.png')
  })
})

describe('uniqueName', () => {
  it('returns the name unchanged when nothing has claimed it', () => {
    expect(uniqueName(new Set(), 'a.png')).toBe('a.png')
  })

  it('suffixes a counter when a name is already taken, so batch outputs cannot overwrite each other', () => {
    const taken = new Set<string>()
    expect(uniqueName(taken, 'photo.jpg')).toBe('photo.jpg')
    expect(uniqueName(taken, 'photo.jpg')).toBe('photo-2.jpg')
    expect(uniqueName(taken, 'photo.jpg')).toBe('photo-3.jpg')
  })

  it('keeps counting past an existing collision rather than reusing it', () => {
    const taken = new Set(['x.png', 'x-2.png'])
    expect(uniqueName(taken, 'x.png')).toBe('x-3.png')
  })
})

describe('stem', () => {
  it('strips directory and extension', () => {
    expect(stem('/tmp/a/b.tar.gz')).toBe('b.tar')
  })
})
