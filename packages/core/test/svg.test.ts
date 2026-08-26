import { describe, expect, it } from 'vitest'
import { assertSvgSafe, svgRisks } from '../src/svg.js'
import { UnsafeSvgError } from '../src/errors.js'

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" ${attrs}>${inner}</svg>`

describe('assertSvgSafe', () => {
  it('accepts an SVG built from plain shapes and text', () => {
    expect(() => assertSvgSafe(wrap('<rect width="40" height="30" fill="blue"/><text y="10">hi</text>'))).not.toThrow()
  })

  it('accepts an embedded data: URI image, which resolves to no network access', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo='
    expect(() => assertSvgSafe(wrap(`<image href="${data}" width="4" height="4"/>`))).not.toThrow()
  })

  it('rejects a DOCTYPE entity declaration, the XXE file-read vector', () => {
    const svg = '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + wrap('<text>&xxe;</text>')
    expect(() => assertSvgSafe(svg)).toThrow(UnsafeSvgError)
    expect(svgRisks(svg)).toContain('doctype')
  })

  it('rejects a script element', () => {
    const svg = wrap('<script>fetch("http://x.invalid")</script>')
    expect(() => assertSvgSafe(svg)).toThrow(UnsafeSvgError)
    expect(svgRisks(svg)).toContain('script')
  })

  it('rejects a script element hidden by odd casing and inner whitespace', () => {
    expect(svgRisks(wrap('<  ScRiPt >alert(1)</ScRiPt>'))).toContain('script')
  })

  it('rejects inline event handler attributes', () => {
    expect(svgRisks(wrap('<rect OnLoAd="alert(1)" width="4" height="4"/>'))).toContain('event-handler')
  })

  it('rejects a remote http reference, which would let a render reach the network', () => {
    expect(svgRisks(wrap('<image href="http://example.invalid/t.png" width="4" height="4"/>'))).toContain(
      'external-reference',
    )
  })

  it('rejects a file:// reference', () => {
    expect(svgRisks(wrap('<image xlink:href="file:///etc/hosts" width="4" height="4"/>'))).toContain(
      'external-reference',
    )
  })

  it('rejects a foreignObject, which escapes SVG into arbitrary HTML', () => {
    expect(svgRisks(wrap('<foreignObject><body>x</body></foreignObject>'))).toContain('foreign-object')
  })

  it('rejects an entity-encoded javascript: URL', () => {
    expect(svgRisks(wrap('<a href="&#106;avascript:alert(1)">x</a>'))).toContain('external-reference')
  })

  it('reports every distinct risk it finds, not just the first', () => {
    const svg = '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'
    expect(svgRisks(svg).sort()).toEqual(['doctype', 'script'])
  })

  it('names the risks in the thrown error so the user learns why it was refused', () => {
    try {
      assertSvgSafe(wrap('<script>x</script>'))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeSvgError)
      expect((err as UnsafeSvgError).risks).toEqual(['script'])
      expect((err as Error).message).toMatch(/script/)
    }
  })
})
