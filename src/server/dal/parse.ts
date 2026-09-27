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

/** Parse a request body or form payload; a failure is a 422 with the field errors. */
export function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Check the highlighted fields.", issuesOf(parsed.error));
  return parsed.data;
}
