// Nunjucks templates are data, not TypeScript, so `tsc -b` does not emit them.
// server.ts resolves its view root as './views' relative to its own compiled
// module, which means the templates have to land in dist alongside the
// JavaScript. Without this step the server boots, answers /healthz, and then
// returns 500 on the first page render — including the error page.
import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export async function copyViews(srcDir, destDir) {
  await mkdir(destDir, { recursive: true })
  await cp(srcDir, destDir, { recursive: true, force: true })
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const src = fileURLToPath(new URL('../src/views', import.meta.url))
  const dest = fileURLToPath(new URL('../dist/views', import.meta.url))
  await copyViews(src, dest)
}
