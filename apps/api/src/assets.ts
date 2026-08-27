import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Directories left out of the stamp. The vendored libraries are named by the
 * package version they came from and change only when a dependency is upgraded;
 * hashing nearly two hundred files at every boot to discover that costs
 * something and tells us nothing.
 */
const UNSTAMPED = new Set(['vendor'])

/**
 * A short hash of everything served from the static directory.
 *
 * Static files are cached hard and their names never change, so a browser that
 * has them keeps them — a new build changes the file and not its address, and
 * nothing is re-fetched. Appending this to the address makes a changed file a
 * changed URL, which is the only thing a cache pays attention to.
 *
 * One stamp for the whole set rather than one per file: a deploy re-fetches a
 * hundred kilobytes of CSS and script once, which is not worth the bookkeeping
 * of tracking each file separately.
 */
export async function assetStamp(dir: string): Promise<string> {
  const hash = createHash('sha256')

  async function walk(at: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await readdir(at, { withFileTypes: true })
    } catch {
      return
    }
    // Sorted, so the stamp depends on the contents and not on the order the
    // filesystem happens to hand them back.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!UNSTAMPED.has(entry.name)) await walk(join(at, entry.name), `${prefix}${entry.name}/`)
        continue
      }
      hash.update(prefix + entry.name)
      hash.update(await readFile(join(at, entry.name)))
    }
  }

  await walk(dir, '')
  return hash.digest('hex').slice(0, 10)
}
