import "server-only";
import type { Refusal } from "./authz";

/** An error that maps to one HTTP status. Route handlers turn it into a JSON body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class AuthzError extends HttpError {
  constructor(refusal: Refusal) {
    super(refusal.status, refusal.code, refusal.message);
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, "not_found", `${what} was not found.`);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(422, "invalid", message, details);
  }
}

export class ConflictError extends HttpError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}
