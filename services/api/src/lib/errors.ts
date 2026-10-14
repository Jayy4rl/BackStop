// Errors carry a stable machine code and a plain-language message the apps can show as is.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(403, code, message, details);
export const notFound = (what = 'Not found.') => new ApiError(404, 'not_found', what);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(409, code, message, details);
export const unavailable = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(503, code, message, details);
export const tooMany = (message = 'Too many attempts. Try again later.') => new ApiError(429, 'rate_limited', message);
