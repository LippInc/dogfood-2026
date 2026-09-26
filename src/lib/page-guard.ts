import "server-only";
import { forbidden, notFound, unauthorized } from "next/navigation";
import { HttpError } from "@/server/dal";

/**
 * Run a data-access call for a page and turn its refusal into Next's real status
 * pages: 401 unauthorized(), 403 forbidden(), 404 notFound(). Call it before any
 * Suspense boundary so the status is sent with the first byte.
 */
export function guardPage<T>(load: () => T): T {
  try {
    return load();
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) unauthorized();
      if (err.status === 403) forbidden();
      if (err.status === 404) notFound();
    }
    throw err;
  }
}

/** "2026-03-01T18:00:00Z" -> "2026-03-01T18:00" for a UTC datetime-local input. */
export function utcInput(iso: string | null | undefined): string {
  return iso ? new Date(iso).toISOString().slice(0, 16) : "";
}
