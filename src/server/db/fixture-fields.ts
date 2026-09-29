import "server-only";
import { z } from "zod";

// The field shapes an event file's rows share: the fixture format's own lists (import-fixtures.ts) and the event's
// history the portal's export adds (import-history.ts).

// Ids end up in addresses, export file names and response headers, so only a safe set of characters.
export const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, "must be 1 to 80 letters, digits, '_', '-' or '.', starting with a letter or digit");

/** An ISO 8601 date and time with its time zone, such as 2026-03-01T18:00:00Z, that is a real day. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export function isIsoDateTime(s: string): boolean {
  const m = ISO_DATE_TIME.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return mo >= 1 && mo <= 12 && day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}
export const dateTime = z.string().refine(isIsoDateTime, "must be a date and time with its time zone, such as 2026-03-01T18:00:00Z");

export const atMost = (n: number, what: string) => `at most ${n.toLocaleString("en")} ${what} in one file; split it into several imports`;
