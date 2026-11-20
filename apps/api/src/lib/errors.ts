/**
 * Typed API error. Route handlers throw these; the error middleware in
 * app.ts maps them to { error: { code, message } } responses. The `code`
 * is a stable machine-readable string; `message` is human-readable.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

export function unauthorized(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

export function forbidden(code: string, message: string): ApiError {
  return new ApiError(403, code, message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}
