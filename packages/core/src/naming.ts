import { basename, extname } from 'node:path'

/** Strip a filename to its stem, with no directory and no extension. */
export function stem(name: string): string {
  return basename(name, extname(name))
}

/**
 * Build an output filename from an input one, optionally swapping extension
 * and appending a suffix. Any directory component is discarded: filenames
 * arrive from users and must never steer where we write.
 */
export function deriveName(inputName: string, opts: { ext?: string; suffix?: string } = {}): string {
  // Backslashes are flattened too: a Windows client can send `a\\b\\c.png`,
  // which POSIX basename() would hand back whole.
  const raw = basename(inputName).replace(/[/\\]/g, '_')

  let base = stem(raw)
  let inferredExt = extname(raw).replace(/^\./, '')

  // A name like `.png` is all extension and no stem: Node reads the leading dot
  // as part of the filename, so extname() comes back empty.
  if (!inferredExt && base.startsWith('.')) {
    inferredExt = base.slice(1)
    base = ''
  }

  const ext = (opts.ext ?? (inferredExt || 'bin')).toLowerCase()
  return `${base || 'image'}${opts.suffix ?? ''}.${ext}`
}

/**
 * Keep names unique within one job. Without this, two inputs called `photo.jpg`
 * from different folders would silently overwrite each other's result.
 */
export function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) {
    taken.add(name)
    return name
  }
  const ext = extname(name)
  const base = basename(name, ext)
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}
