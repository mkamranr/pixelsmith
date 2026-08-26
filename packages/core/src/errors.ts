import { PixelsmithError } from '@pixelsmith/contracts'

export { PixelsmithError } from '@pixelsmith/contracts'

export class UnknownToolError extends PixelsmithError {
  constructor(readonly toolId: string) {
    super('unknown_tool', 404, `No such tool: ${toolId}`)
  }
}

export interface ParamIssue {
  /** Dot-joined field path, e.g. `size.width`. Empty string for root. */
  path: string
  message: string
}

export class InvalidParamsError extends PixelsmithError {
  constructor(
    readonly toolId: string,
    readonly issues: ParamIssue[],
  ) {
    super(
      'invalid_params',
      400,
      `Invalid parameters for ${toolId}: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
    )
  }
}

export class UnsupportedInputError extends PixelsmithError {
  constructor(
    readonly toolId: string,
    readonly mime: string,
  ) {
    super('unsupported_input', 415, `${toolId} cannot process ${mime}`)
  }
}

export class MalformedImageError extends PixelsmithError {
  constructor(detail: string) {
    super('malformed_image', 422, `Image could not be read: ${detail}`)
  }
}

export class LimitExceededError extends PixelsmithError {
  constructor(
    readonly limit: string,
    detail: string,
  ) {
    super('limit_exceeded', 413, `Input rejected (${limit}): ${detail}`)
  }
}

export class UnsafeSvgError extends PixelsmithError {
  constructor(readonly risks: string[]) {
    super('unsafe_svg', 422, `SVG refused, it contains: ${risks.join(', ')}`)
  }
}

export class BadInputError extends PixelsmithError {
  constructor(detail: string) {
    super('bad_input', 400, detail)
  }
}

export class InferenceUnavailableError extends PixelsmithError {
  constructor(detail: string) {
    // 503, not 500: the request was fine, the capability is not there. A
    // retry after the sidecar comes back will succeed.
    super('inference_unavailable', 503, `Inference unavailable: ${detail}`)
  }
}

export class InferenceFailedError extends PixelsmithError {
  constructor(detail: string) {
    super('inference_failed', 502, `Inference failed: ${detail}`)
  }
}
