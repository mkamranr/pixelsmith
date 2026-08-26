import { PixelsmithError } from '@pixelsmith/contracts'

export { PixelsmithError, isPixelsmithError } from '@pixelsmith/contracts'

export class UnsafePathError extends PixelsmithError {
  constructor(detail: string) {
    super('unsafe_path', 400, `Refused path: ${detail}`)
  }
}
