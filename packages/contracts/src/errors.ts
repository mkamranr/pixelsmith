/**
 * The one error base shared by every package. The API maps `code` and `status`
 * straight onto a response, and workers decide retry-vs-fail from `code`, so
 * both need a single definition rather than one per package.
 */
export class PixelsmithError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.status = status
  }
}

/** True for errors we raised deliberately and can safely show a user. */
export function isPixelsmithError(err: unknown): err is PixelsmithError {
  return err instanceof PixelsmithError
}
