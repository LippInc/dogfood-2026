import "server-only";
import { NextResponse } from "next/server";
import { HttpError } from "./errors";

// Route handlers wrap their work in route(): a thrown HttpError becomes a JSON
// body with the same status, anything else a 500 that hides the details. A
// refusal is always a real 401/403 from here, never a redirect to a login page.

export function json(body: unknown, status = 200, headers?: HeadersInit): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function route(work: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    console.error("[api] unexpected error:", err);
    return json({ error: "internal", message: "Something went wrong on our side." }, 500);
  }
}

export type ActionResult = { ok: boolean; message: string | null; fieldErrors?: Record<string, string[]> };

/**
 * Server actions return refusals and validation errors as data for the form to
 * show; anything else (including Next's own redirect signal) is rethrown.
 */
export function actionError(err: unknown): ActionResult {
  if (err instanceof HttpError) {
    const fieldErrors =
      err.details && typeof err.details === "object" ? (err.details as Record<string, string[]>) : undefined;
    return { ok: false, message: err.message, fieldErrors };
  }
  throw err;
}
