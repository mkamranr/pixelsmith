import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jobStorage } from '../src/storage.js'
import { UnsafePathError } from '../src/errors.js'

const UUID = '3f6c1a52-9f0e-4c1b-9c2e-2b7c9a1d4e55'
const OTHER = '11111111-2222-4333-8444-555555555555'
/** A real null byte. Some syscalls truncate at one, so it must never validate. */
const NUL = String.fromCharCode(0)

let root: string
let store: ReturnType<typeof jobStorage>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pixelsmith-store-'))
  store = jobStorage(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('jobDir', () => {
  it('places a job under the storage root', () => {
    expect(store.jobDir(UUID)).toBe(join(root, 'jobs', UUID))
  })

  it.each([
    ['traversal', '../../etc'],
    ['absolute', '/etc/passwd'],
    ['empty', ''],
    ['not a uuid', 'my-job'],
    ['a uuid with a suffix', UUID + '/../..'],
    ['a null byte', UUID + NUL],
  ])('refuses a job id that is %s, so an id cannot steer the filesystem', (_label, bad) => {
    expect(() => store.jobDir(bad)).toThrow(UnsafePathError)
  })
})

describe('resolveFile', () => {
  it('resolves a plain output filename', () => {
    expect(store.resolveFile(UUID, 'out/a.png')).toBe(join(root, 'jobs', UUID, 'out', 'a.png'))
  })

  it.each([
    ['parent traversal', '../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['traversal after a valid segment', 'out/../../../etc/passwd'],
    ['a bare parent', '..'],
    ['a null byte', 'out/a' + NUL + '.png'],
  ])('refuses %s', (_label, bad) => {
    expect(() => store.resolveFile(UUID, bad)).toThrow(UnsafePathError)
  })

  it('refuses a path that escapes into a sibling job directory', () => {
    expect(() => store.resolveFile(UUID, '..' + sep + OTHER + sep + 'out' + sep + 'a.png')).toThrow(UnsafePathError)
  })

  it('allows a name that merely contains dots', () => {
    expect(() => store.resolveFile(UUID, 'out/my..file.png')).not.toThrow()
  })
})

describe('prepare', () => {
  it('creates the input and output directories', async () => {
    const { inDir, outDir } = await store.prepare(UUID)
    await writeFile(join(inDir, 'x.png'), 'x')
    await writeFile(join(outDir, 'y.png'), 'y')
    expect(inDir).toBe(join(root, 'jobs', UUID, 'in'))
    expect(outDir).toBe(join(root, 'jobs', UUID, 'out'))
  })
})

describe('readable', () => {
  it('returns the real path for a file genuinely inside the job', async () => {
    const { outDir } = await store.prepare(UUID)
    await writeFile(join(outDir, 'ok.png'), 'data')
    await expect(store.readable(UUID, 'out/ok.png')).resolves.toContain(UUID + sep + 'out' + sep + 'ok.png')
  })

  it('refuses a symlink pointing outside the job, which a lexical check alone would miss', async () => {
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'classified')
    const { outDir } = await store.prepare(UUID)
    await symlink(secret, join(outDir, 'link.png'))

    // The lexical path looks fine; only resolving the link reveals the escape.
    expect(() => store.resolveFile(UUID, 'out/link.png')).not.toThrow()
    await expect(store.readable(UUID, 'out/link.png')).rejects.toThrow(UnsafePathError)
  })

  it('rejects a file that does not exist', async () => {
    await store.prepare(UUID)
    await expect(store.readable(UUID, 'out/missing.png')).rejects.toThrow()
  })
})

describe('remove', () => {
  it('deletes the whole job directory', async () => {
    const { outDir } = await store.prepare(UUID)
    await writeFile(join(outDir, 'a.png'), 'a')
    await store.remove(UUID)
    await expect(store.readable(UUID, 'out/a.png')).rejects.toThrow()
  })

  it('refuses an invalid id rather than deleting something unexpected', async () => {
    await expect(store.remove('../..')).rejects.toThrow(UnsafePathError)
  })

  it('is silent when the directory is already gone', async () => {
    await expect(store.remove(UUID)).resolves.toBeUndefined()
  })
})

describe('listJobDirs', () => {
  it('lists job directories, so the sweeper can find orphans with no database row', async () => {
    await store.prepare(UUID)
    await store.prepare(OTHER)
    await mkdir(join(root, 'jobs', 'not-a-uuid'), { recursive: true })
    expect((await store.listJobDirs()).sort()).toEqual([OTHER, UUID].sort())
  })

  it('returns nothing when no jobs have ever been created', async () => {
    expect(await store.listJobDirs()).toEqual([])
  })
})
