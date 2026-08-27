// Browser libraries served from this host.
//
// The PDF workspace renders page thumbnails in the browser with pdf.js. There
// is no CDN to fetch it from on an air-gapped network, so the build copies it
// out of node_modules into the directory the app serves. Copied rather than
// committed, so it can never drift from the version in the lockfile.
import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)

/** The minified browser build and its worker, which pdf.js needs separately. */
export const PDFJS_FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs']

/**
 * Data pdf.js fetches while rendering, rather than up front.
 *
 * `standard_fonts` holds the metrics and outlines for the 14 fonts a PDF is
 * allowed to assume are present. Without them pdf.js requests each one from a
 * default relative path, gets a 404, and spends seconds per page instead of
 * milliseconds. `cmaps` does the same job for CID-encoded text, which is how
 * plenty of Arabic and CJK documents store their characters.
 */
export const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps']

export async function copyPdfjs(destDir) {
  const root = dirname(require_.resolve('pdfjs-dist/package.json'))
  await mkdir(destDir, { recursive: true })

  for (const file of PDFJS_FILES) {
    await cp(join(root, 'build', file), join(destDir, file), { force: true })
  }
  for (const directory of PDFJS_ASSET_DIRS) {
    await cp(join(root, directory), join(destDir, directory), { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  await copyPdfjs(fileURLToPath(new URL('../public/vendor/pdfjs', import.meta.url)))
}
