// All API errors share one shape: { error: { code, message, details? } }
// The frontend translates `code` into Bangla / English.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message || code);
  }
}

export const badRequest = (code: string, message?: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (code = "UNAUTHORIZED", message = "Please sign in") => new ApiError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "You are not allowed to do this") => new ApiError(403, code, message);
export const notFound = (code = "NOT_FOUND", message = "Not found") => new ApiError(404, code, message);
export const conflict = (code: string, message?: string, details?: unknown) => new ApiError(409, code, message, details);
