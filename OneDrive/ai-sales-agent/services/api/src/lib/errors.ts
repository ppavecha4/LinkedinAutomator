/**
 * Structured API errors. Handlers `throw new ApiError(...)` and a single
 * error middleware converts them to the `{error}` response shape.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'unauthorized'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'forbidden', details?: unknown): ApiError {
    return new ApiError(403, 'FORBIDDEN', message, details);
  }
  static notFound(message = 'not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError(409, 'CONFLICT', message, details);
  }
  static internal(message = 'internal error', details?: unknown): ApiError {
    return new ApiError(500, 'INTERNAL', message, details);
  }
}
