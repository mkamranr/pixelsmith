import { PixelsmithError } from '@pixelsmith/contracts'

export { PixelsmithError, isPixelsmithError } from '@pixelsmith/contracts'

export { UnsafePathError } from '@pixelsmith/jobs'

export class UnauthorizedError extends PixelsmithError {
  constructor(message = 'Sign in to continue') {
    super('unauthorized', 401, message)
  }
}

export class ForbiddenError extends PixelsmithError {
  constructor(message = 'You do not have access to this') {
    super('forbidden', 403, message)
  }
}

export class NotFoundError extends PixelsmithError {
  constructor(what = 'Resource') {
    super('not_found', 404, `${what} not found`)
  }
}

export class BadRequestError extends PixelsmithError {
  constructor(message: string) {
    super('bad_request', 400, message)
  }
}

export class TooManyFilesError extends PixelsmithError {
  constructor(limit: number) {
    super('too_many_files', 413, `A single job accepts at most ${limit} files`)
  }
}
