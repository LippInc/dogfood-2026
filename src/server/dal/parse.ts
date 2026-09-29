import "server-only";
import { z } from "zod";
import { ValidationError } from "../errors";

/**
 * The errors of a failed parse, keyed by field. A problem with the body as a whole (a
 * list sent where an object belongs, or no JSON at all) has no field, so it goes under
 * `request`; without it an API caller would get "Check the highlighted fields." and
 * nothing highlighted.
 */
export function issuesOf(error: z.ZodError): Record<string, string[] | undefined> {
  const { formErrors, fieldErrors } = z.flattenError(error);
  return formErrors.length ? { ...fieldErrors, request: formErrors } : fieldErrors;
}

/** Parse a request body or form payload; a failure is a 422 with the field errors, under the message given. */
export function parse<T extends z.ZodType>(schema: T, body: unknown, message = "Check the highlighted fields."): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError(message, issuesOf(parsed.error));
  return parsed.data;
}

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z?$/;
const UTC_MESSAGE = "use the date picker, or a UTC time such as 2026-10-01T18:00Z";

/** The ISO form of a time written as UTC, or null when it is no real moment (month 13, 30 February, 24:00). */
function toIso(v: string): string | null {
  if (!UTC_TIME.test(v)) return null;
  const d = new Date(v.endsWith("Z") ? v : `${v}Z`);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.slice(0, 16) === v.slice(0, 16) ? iso : null;
}

/**
 * A time, read as UTC: "2026-10-01T18:00" from the form's date picker, or full ISO 8601
 * with Z from an API caller. Stored in ISO form. One schema for every date an organizer
 * sets, so the form and the API agree and an impossible date is a 422, not a crash.
 */
export const utcTime = z
  .string()
  .trim()
  .refine((v) => toIso(v) !== null, UTC_MESSAGE)
  .transform((v) => toIso(v)!)
  .describe("A UTC time: 2026-10-01T18:00, or ISO 8601 such as 2026-10-01T18:00:00Z");

/** The same, or "" for a time left empty (kept as ""). */
export const utcTimeOrEmpty = z
  .string()
  .trim()
  .refine((v) => v === "" || toIso(v) !== null, UTC_MESSAGE)
  .transform((v) => (v === "" ? "" : toIso(v)!))
  .describe('A UTC time: 2026-10-01T18:00, or ISO 8601 such as 2026-10-01T18:00:00Z; "" for none');
