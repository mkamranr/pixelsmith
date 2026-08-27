import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyViews } from '../scripts/copy-views.mjs'
import { copyPdfjs, PDFJS_ASSET_DIRS, PDFJS_FILES } from '../scripts/copy-vendor.mjs'
import { BRAND_FILES, buildBrandAssets, findBands, keyOutPaper } from '../scripts/build-brand.mjs'

const API_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

async function treeOf(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

describe('copyViews', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixelsmith-packaging-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reproduces a nested template tree at the destination', async () => {
    const src = join(dir, 'src', 'views')
    await mkdir(join(src, 'partials'), { recursive: true })
    await writeFile(join(src, 'layout.njk'), '<html>{% block body %}{% endblock %}</html>')
    await writeFile(join(src, 'partials', 'nav.njk'), '<nav>menu</nav>')

    const dest = join(dir, 'dist', 'views')
    await copyViews(src, dest)

    expect(await treeOf(dest)).toEqual(['layout.njk', join('partials', 'nav.njk')])
    expect(await readFile(join(dest, 'partials', 'nav.njk'), 'utf8')).toBe('<nav>menu</nav>')
  })

  it('overwrites a stale copy so an edited template does not ship outdated', async () => {
    const src = join(dir, 'src', 'views')
    const dest = join(dir, 'dist', 'views')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'home.njk'), 'first')
    await copyViews(src, dest)

    await writeFile(join(src, 'home.njk'), 'second')
    await copyViews(src, dest)

    expect(await readFile(join(dest, 'home.njk'), 'utf8')).toBe('second')
  })
})

describe('packaged runtime layout', () => {
  // server.ts resolves these three asset roots relative to its own compiled
  // module. Anything addressed as './x' therefore has to be copied into dist by
  // the build; anything addressed as '../x' resolves the same from src and dist
  // and must stay outside src. Getting this wrong boots fine and then 500s on
  // the first page render, which is how it escaped every route test.
  it('places every template where the compiled server will look for it', async () => {
    const src = join(API_ROOT, 'src', 'views')
    const dest = join(API_ROOT, 'dist', 'views')
    await copyViews(src, dest)

    expect(await treeOf(dest)).toEqual(await treeOf(src))
    expect((await treeOf(dest)).length).toBeGreaterThan(0)
  })

  it('keeps public assets and db migrations outside src so ../ resolves from dist', async () => {
    expect(await treeOf(join(API_ROOT, 'public'))).toContain('styles.css')
    expect(await treeOf(join(REPO_ROOT, 'packages', 'db', 'migrations'))).toContainEqual(
      expect.stringMatching(/\.sql$/),
    )
  })
})

describe('build wiring', () => {
  it('runs the template copy as part of the api build, not just tsc', async () => {
    const pkg = JSON.parse(await readFile(join(API_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toMatch(/copy-views/)
  })

  it('builds container images through npm run build so there is one build authority', async () => {
    for (const name of ['api.Dockerfile', 'runner.Dockerfile']) {
      const text = await readFile(join(REPO_ROOT, 'infra', 'docker', name), 'utf8')
      expect(text, `${name} must not invoke tsc directly`).not.toMatch(/^\s*RUN\s+npx tsc -b\s*$/m)
      expect(text, `${name} must run the workspace build`).toMatch(/RUN npm run build/)
    }
  })
})

/**
 * api and runner run as node (uid 1000, gid 1000) and own /data. The inference
 * sidecar deliberately runs as a different uid so a model exploit is not also a
 * job-store compromise — but it has to write results into the shared volume, so
 * it must share the group. Without that it reads inputs and fails on the write.
 */
describe('shared volume access across containers', () => {
  it('puts the inference user in the group that owns the data volume', async () => {
    const text = await readFile(join(REPO_ROOT, 'infra', 'docker', 'inference.Dockerfile'), 'utf8')
    expect(text, 'inference must join gid 1000, the group owning /data').toMatch(
      /--gid[= ]1000|groupmod|usermod -g 1000/,
    )
    expect(text, 'inference must still have its own uid').toMatch(/--uid[= ]1001/)
  })
})

/**
 * The PDF workspace renders page thumbnails in the browser, which needs pdf.js
 * served from this host — there is no CDN to reach on an air-gapped network. It
 * is copied out of node_modules at build time, so it has to be copied for real
 * or the thumbnails silently never appear.
 */
describe('vendored browser libraries', () => {
  it('copies the pdf.js browser build and its worker into the served assets', async () => {
    const dest = join(API_ROOT, 'public', 'vendor', 'pdfjs')
    await copyPdfjs(dest)

    const present = await treeOf(dest)
    for (const file of PDFJS_FILES) expect(present).toContain(file)
  })

  it('ships the standard font data pdf.js needs to render text', async () => {
    /**
     * Without it pdf.js asks for the fonts on a default relative path, gets a
     * 404 for every page that uses Helvetica or Times, and takes seconds per
     * page instead of milliseconds. The server-side rasteriser has always
     * pointed at these; the browser did not, and the page grid crawled.
     */
    const dest = join(API_ROOT, 'public', 'vendor', 'pdfjs')
    await copyPdfjs(dest)
    const present = await treeOf(dest)

    for (const directory of PDFJS_ASSET_DIRS) {
      const inside = present.filter((file) => file.startsWith(`${directory}/`))
      expect(inside.length, `${directory} is empty`).toBeGreaterThan(5)
    }
  })

  it('runs the vendor copy as part of the api build', async () => {
    const pkg = JSON.parse(await readFile(join(API_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toMatch(/copy-vendor/)
  })
})

/**
 * The logo arrives as one flat PNG on white paper; everything the app serves is
 * derived from it at build time. Derived rather than committed, so there is a
 * single source of truth and no binary to keep in step by hand.
 */
describe('brand assets', () => {
  const source = join(REPO_ROOT, 'assets', 'brand', 'pixelsmith-source.png')
  const dest = join(API_ROOT, 'public', 'brand')

  it('produces every file the pages ask for', async () => {
    await buildBrandAssets(source, dest)
    const present = await treeOf(dest)
    for (const file of BRAND_FILES) expect(present).toContain(file)
  })

  it('keeps the white shapes inside the mark and drops the paper around it', async () => {
    const keyed = await keyOutPaper(source)
    const alphaAt = (x: number, y: number) => keyed.rgba[(y * keyed.width + x) * 4 + 3]

    // The corners are paper.
    expect(alphaAt(2, 2)).toBe(0)
    expect(alphaAt(keyed.width - 3, keyed.height - 3)).toBe(0)

    /**
     * Somewhere inside the mark there is white that belongs to the artwork —
     * the label on the red card. A plain "make white transparent" pass would
     * have punched it out; flooding inwards from the edges cannot reach it.
     */
    const [mark] = findBands(keyed)
    let enclosedWhite = 0
    for (let y = mark!.top; y <= mark!.bottom; y++) {
      for (let x = mark!.left; x <= mark!.right; x++) {
        const i = (y * keyed.width + x) * 4
        const isWhite = keyed.rgba[i]! > 245 && keyed.rgba[i + 1]! > 245 && keyed.rgba[i + 2]! > 245
        if (isWhite && keyed.rgba[i + 3] === 255) enclosedWhite++
      }
    }
    expect(enclosedWhite).toBeGreaterThan(500)
  })

  it('builds icons from the mark alone, with no wordmark dragged in', async () => {
    /**
     * Squaring the crop box instead of padding after the crop reached into the
     * wordmark below, and every icon shipped with "pixelsmith" shrunk to a
     * smear along the bottom. The mark is padded to a square, so the strip
     * where that appeared has to be empty.
     */
    await buildBrandAssets(source, dest)
    const icon = sharp(join(dest, 'icon-512.png'))
    const { width, height } = await icon.metadata()
    expect(width).toBe(height)

    const strip = await icon
      .clone()
      .extract({ left: 0, top: Math.round(height! * 0.92), width: width!, height: Math.round(height! * 0.08) })
      .toBuffer()
    const alpha = (await sharp(strip).stats()).channels[3]
    expect(alpha!.max).toBe(0)
  })

  it('gives both images the logo source their build step needs', async () => {
    /**
     * The build derives the icons from `assets/brand`, and both Dockerfiles run
     * the workspace build — so both need that directory in the image. Without
     * it the build failed with "Input file is missing" only once it reached
     * Docker, which every local test had passed straight over.
     */
    for (const name of ['api.Dockerfile', 'runner.Dockerfile']) {
      const text = await readFile(join(REPO_ROOT, 'infra', 'docker', name), 'utf8')
      expect(text, `${name} must copy the brand source`).toMatch(/^COPY assets\/brand /m)
    }
  })

  it('runs the brand build as part of the api build', async () => {
    const pkg = JSON.parse(await readFile(join(API_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toMatch(/build-brand/)
  })
})
