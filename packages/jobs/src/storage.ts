import { chmod, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { UnsafePathError } from './errors.js'

/**
 * Job ids are the only thing that ever names a directory, so they are held to a
 * strict UUID shape. Anything else — a traversal, an absolute path, a null byte —
 * is refused before it can touch the filesystem.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface JobPaths {
  dir: string
  inDir: string
  outDir: string
}

export function jobStorage(root: string) {
  const jobsRoot = join(root, 'jobs')

  const assertJobId = (id: string): string => {
    if (!UUID_RE.test(id)) throw new UnsafePathError(`${JSON.stringify(id)} is not a job id`)
    return id
  }

  const jobDir = (id: string): string => join(jobsRoot, assertJobId(id))

  /**
   * Lexical containment check. Fast, synchronous, and enough for paths we are
   * about to create — but blind to symlinks, which is why reads go through
   * `readable` instead.
   */
  const resolveFile = (id: string, relPath: string): string => {
    const dir = jobDir(id)
    if (relPath.includes('\0')) throw new UnsafePathError('path contains a null byte')
    if (isAbsolute(relPath)) throw new UnsafePathError('path must be relative to the job')

    const full = resolve(dir, relPath)
    if (full !== dir && !full.startsWith(dir + sep)) {
      throw new UnsafePathError('path escapes the job directory')
    }
    return full
  }

  return {
    root,
    jobsRoot,
    jobDir,
    resolveFile,

    paths(id: string): JobPaths {
      const dir = jobDir(id)
      return { dir, inDir: join(dir, 'in'), outDir: join(dir, 'out') }
    },

    async prepare(id: string): Promise<JobPaths> {
      const p = this.paths(id)
      await mkdir(p.inDir, { recursive: true })
      await mkdir(p.outDir, { recursive: true })

      // The inference sidecar is a different container running as a different
      // uid, and it writes its result directly into this directory. mkdir's
      // mode argument is masked by the umask, so the group write bit has to be
      // set explicitly afterwards or the sidecar reads the input and then fails
      // on the write. The group holds only this stack's own services.
      await chmod(p.inDir, 0o775)
      await chmod(p.outDir, 0o775)
      return p
    },

    /**
     * Resolve a path for reading, following symlinks and confirming the *real*
     * target is still inside the job. A lexical check passes a symlink happily;
     * only realpath reveals that `out/link.png` points at /etc/shadow.
     */
    async readable(id: string, relPath: string): Promise<string> {
      const candidate = resolveFile(id, relPath)
      // Resolve the job root too: on macOS /var is itself a symlink, so
      // comparing a real path against a lexical one would never match.
      const realRoot = await realpath(jobDir(id))
      const realTarget = await realpath(candidate)

      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        throw new UnsafePathError('path resolves outside the job directory')
      }
      return realTarget
    },

    async remove(id: string): Promise<void> {
      await rm(jobDir(id), { recursive: true, force: true })
    },

    /** Every job directory on disk, for the sweeper to reconcile against the database. */
    async listJobDirs(): Promise<string[]> {
      try {
        const entries = await readdir(jobsRoot, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory() && UUID_RE.test(e.name)).map((e) => e.name)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    },
  }
}

export type JobStorage = ReturnType<typeof jobStorage>
