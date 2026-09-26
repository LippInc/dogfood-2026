import "server-only";
import { z } from "zod";
import { ValidationError } from "../errors";

/** Parse a request body or form payload; a failure is a 422 with the field errors. */
export function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Check the highlighted fields.", z.flattenError(parsed.error).fieldErrors);
  return parsed.data;
}
