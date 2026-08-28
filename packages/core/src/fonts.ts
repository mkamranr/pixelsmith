import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { GlobalFonts } from '@napi-rs/canvas'

export interface HandwritingFace {
  /** How it is described to somebody choosing one. */
  label: string
  /** The family name inside the file, which is what drawing code asks for. */
  family: string
  file: string
}

/**
 * Faces for a typed signature.
 *
 * A signature set in Helvetica does not read as a signature, which is what the
 * typed option produced before these existed. All three are SIL OFL, fetched
 * against pinned checksums by infra/bundle/fetch-assets.sh and recorded in
 * infra/bundle/assets.manifest with their licence text beside them.
 */
export const HANDWRITING_FACES: Record<string, HandwritingFace> = {
  'great-vibes': { label: 'Formal', family: 'Great Vibes', file: 'GreatVibes-Regular.ttf' },
  'dancing-script': { label: 'Flowing', family: 'Dancing Script', file: 'DancingScript-Variable.ttf' },
  caveat: { label: 'Handwritten', family: 'Caveat', file: 'Caveat-Variable.ttf' },
}

export function handwritingFace(id: string | undefined): HandwritingFace | undefined {
  return id ? HANDWRITING_FACES[id] : undefined
}

/**
 * Register the faces with the drawing library, once per process.
 *
 * Registered in-process rather than installed into the image: fontconfig is not
 * configured the same way on every machine this runs on — including the one the
 * tests run on — and a font that is silently ignored looks exactly like a font
 * that was never asked for. This way the family is either registered or it is
 * not, and the return value says which.
 *
 * Returns the families now available. An empty list means the directory was not
 * there, which is what an image built without the assets fetched looks like:
 * the tools that want a face fall back rather than the worker failing to start.
 */
export function registerHandwritingFaces(dir: string): string[] {
  const registered: string[] = []
  for (const face of Object.values(HANDWRITING_FACES)) {
    const path = join(dir, face.file)
    if (!existsSync(path)) continue
    // Registering the same file twice is harmless and returns false, so the
    // family is reported as available either way.
    GlobalFonts.registerFromPath(path, face.family)
    if (GlobalFonts.has(face.family)) registered.push(face.family)
  }
  return registered
}
