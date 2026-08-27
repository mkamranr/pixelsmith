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

export async function copyPdfjs(destDir) {
  const build = join(dirname(require_.resolve('pdfjs-dist/package.json')), 'build')
  await mkdir(destDir, { recursive: true })
  for (const file of PDFJS_FILES) {
    await cp(join(build, file), join(destDir, file), { force: true })
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  await copyPdfjs(fileURLToPath(new URL('../public/vendor/pdfjs', import.meta.url)))
}
