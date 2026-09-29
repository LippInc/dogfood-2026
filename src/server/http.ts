import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { PERSON_HEADER } from "@/lib/session-watch";
import { ConflictError, HttpError } from "./errors";
import { currentActor } from "./session";

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
      const retry = err.status === 429 ? (err.details as { retryAfter?: number } | undefined)?.retryAfter : undefined;
      return json(
        { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        err.status,
        retry ? { "retry-after": String(retry) } : undefined,
      );
    }
    console.error("[api] unexpected error:", err);
    return json({ error: "internal", message: "Something went wrong on our side." }, 500);
  }
}

/**
 * The judge console's saves name the person their page was drawn for (the x-dogfood-person header,
 * src/lib/session-watch.ts). One browser keeps one sign-in for all its tabs, so a tab drawn for one person can send
 * its save after another tab signed in as someone else, or signed out. A route those saves reach calls this first:
 * such a save is refused 409 session_changed before anything else runs (no authorize(), no write), since it was meant
 * for the page's person, not the session's. A request without the header (the API, run.py, the hand checks, curl) is
 * not checked at all.
 */
export async function samePagePerson(): Promise<void> {
  let want: string | null = null;
  try {
    want = (await headers()).get(PERSON_HEADER);
  } catch {
    return; // outside a request (a unit test calling a handler without one)
  }
  if (!want) return;
  const actor = await currentActor();
  if (actor?.userId === want) return;
  throw new ConflictError(
    "session_changed",
    actor
      ? `Not saved: this page was opened as someone else, and this browser is now signed in as ${actor.name}. Reload the page.`
      : "Not saved: this browser is signed out now. Reload the page and sign in again.",
  );
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
