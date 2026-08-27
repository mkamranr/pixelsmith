import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assetStamp } from '../src/assets.js'
import { openApp } from './helpers/app.js'

/**
 * Static files are served with a week-long cache and stable names, which means
 * a browser that has them keeps them for a week — a new build changes the file
 * and not its address, so nothing is re-fetched. That is why an instance can
 * look unchanged after a deploy: the pages are new and the stylesheet is a week
 * old. Stamping the address with a hash of what is being served makes a changed
 * file a changed URL, which is the only thing a cache pays attention to.
 */
describe('the stamp on a static file address', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixelsmith-assets-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is the same for the same files', async () => {
    await writeFile(join(dir, 'styles.css'), 'body { color: red }')

    expect(await assetStamp(dir)).toBe(await assetStamp(dir))
  })

  it('is short enough to read in a URL', async () => {
    await writeFile(join(dir, 'styles.css'), 'body { color: red }')
    const stamp = await assetStamp(dir)

    expect(stamp).toMatch(/^[0-9a-f]{8,12}$/)
  })

  it('changes when a file changes', async () => {
    await writeFile(join(dir, 'styles.css'), 'body { color: red }')
    const before = await assetStamp(dir)

    await writeFile(join(dir, 'styles.css'), 'body { color: blue }')

    expect(await assetStamp(dir)).not.toBe(before)
  })

  it('changes when a file is added', async () => {
    await writeFile(join(dir, 'styles.css'), 'body { color: red }')
    const before = await assetStamp(dir)

    await writeFile(join(dir, 'boxes.js'), '// new')

    expect(await assetStamp(dir)).not.toBe(before)
  })

  it('ignores the vendored libraries', async () => {
    // Nearly two hundred files, hashed at every boot for a directory that only
    // changes when a dependency is upgraded. The cost is real and the benefit
    // is not: those files are named by their package version already.
    await writeFile(join(dir, 'styles.css'), 'body { color: red }')
    await mkdir(join(dir, 'vendor', 'pdfjs'), { recursive: true })
    const before = await assetStamp(dir)

    await writeFile(join(dir, 'vendor', 'pdfjs', 'pdf.min.mjs'), 'anything')

    expect(await assetStamp(dir)).toBe(before)
  })
})

describe('the pages that point at those files', () => {
  let h: Awaited<ReturnType<typeof openApp>>

  beforeEach(async () => {
    h = await openApp()
  })
  afterEach(() => h.close())

  it('addresses the stylesheet with a stamp', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/' })

    expect(page.body).toMatch(/\/static\/styles\.css\?v=[0-9a-f]{8,12}/)
  })

  it('addresses the scripts with one too', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/tools/blur-faces' })

    expect(page.body).toMatch(/\/static\/boxes\.js\?v=[0-9a-f]{8,12}/)
    expect(page.body).toMatch(/\/static\/canvas\.js\?v=[0-9a-f]{8,12}/)
  })

  it('leaves no unstamped address behind', async () => {
    // One missed reference is one file that stays stale, and it will be the one
    // that matters.
    const pages = ['/', '/tools/blur-faces', '/tools/pdf-crop', '/tools/crop', '/tools/editor']
    const unstamped: string[] = []

    for (const url of pages) {
      const body = (await h.app.inject({ method: 'GET', url })).body
      for (const [match] of body.matchAll(/\/static\/[a-zA-Z0-9./_-]+/g)) {
        // The vendored libraries carry their own version and are excluded above.
        if (match.startsWith('/static/vendor/')) continue
        if (!body.includes(`${match}?v=`)) unstamped.push(`${url} → ${match}`)
      }
    }

    expect(unstamped).toEqual([])
  })

  it('still serves the file when asked for by its stamped address', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/' })
    const stamped = /\/static\/styles\.css\?v=[0-9a-f]+/.exec(page.body)![0]

    const file = await h.app.inject({ method: 'GET', url: stamped })

    expect(file.statusCode).toBe(200)
    expect(file.headers['content-type']).toMatch(/text\/css/)
  })
})
