export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffChange {
  kind: DiffKind
  text: string
}

/**
 * How many lines of genuinely differing material will be aligned line by line.
 *
 * Alignment is quadratic in both time and memory. Two thousand lines is a
 * 4-million-cell table — around 16MB, which is affordable. Ten thousand would
 * be 400MB, which is not. Past the cap the block is reported as wholly
 * replaced, which is honest, rather than approximated or left to grind.
 */
export const DIFF_LINE_CAP = 2000

/** Longest-common-subsequence alignment. Assumes both sides are within the cap. */
function align(before: string[], after: string[]): DiffChange[] {
  const rows = before.length
  const columns = after.length
  const width = columns + 1
  // Length of the longest common subsequence of before[i..] and after[j..].
  const lengths = new Int32Array((rows + 1) * width)

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lengths[i * width + j] =
        before[i] === after[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    }
  }

  const changes: DiffChange[] = []
  let i = 0
  let j = 0

  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      changes.push({ kind: 'same', text: before[i]! })
      i++
      j++
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      // Removing keeps at least as much in common, and reporting the removal
      // first reads more naturally than the reverse.
      changes.push({ kind: 'removed', text: before[i]! })
      i++
    } else {
      changes.push({ kind: 'added', text: after[j]! })
      j++
    }
  }

  while (i < rows) changes.push({ kind: 'removed', text: before[i++]! })
  while (j < columns) changes.push({ kind: 'added', text: after[j++]! })

  return changes
}

/**
 * Compare two lists of lines and say what changed.
 *
 * Identical material at the start and end is matched off first. Two revisions
 * of the same document usually share nearly all of their lines, so this keeps
 * the expensive alignment working on the part that actually differs.
 */
export function diffLines(before: string[], after: string[]): DiffChange[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++

  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }

  const middleBefore = before.slice(start, endBefore)
  const middleAfter = after.slice(start, endAfter)

  let middle: DiffChange[]
  if (middleBefore.length === 0) {
    middle = middleAfter.map((text) => ({ kind: 'added' as const, text }))
  } else if (middleAfter.length === 0) {
    middle = middleBefore.map((text) => ({ kind: 'removed' as const, text }))
  } else if (middleBefore.length > DIFF_LINE_CAP || middleAfter.length > DIFF_LINE_CAP) {
    middle = [
      ...middleBefore.map((text) => ({ kind: 'removed' as const, text })),
      ...middleAfter.map((text) => ({ kind: 'added' as const, text })),
    ]
  } else {
    middle = align(middleBefore, middleAfter)
  }

  return [
    ...before.slice(0, start).map((text) => ({ kind: 'same' as const, text })),
    ...middle,
    ...before.slice(endBefore).map((text) => ({ kind: 'same' as const, text })),
  ]
}
