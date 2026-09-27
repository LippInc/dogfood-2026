import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "@/server/dal/parse";
import { ValidationError } from "@/server/errors";

function refusal(schema: z.ZodType, body: unknown): ValidationError {
  try {
    parse(schema, body);
  } catch (e) {
    if (e instanceof ValidationError) return e;
    throw e;
  }
  throw new Error("parse accepted the body");
}

describe("parse", () => {
  const Rows = z.array(z.object({ name: z.string().min(1, "a track needs a name") }));
  const Named = z.object({ name: z.string().min(1, "a name is required") });

  it("names a body of the wrong shape under request, so a 422 always says what is wrong", () => {
    const e = refusal(Rows, { name: "Security" });
    expect(e.status).toBe(422);
    expect(e.details).toEqual({ request: ["Invalid input: expected array, received object"] });
  });

  it("keeps field errors under their field and adds no request key", () => {
    const e = refusal(Named, { name: "" });
    expect(e.details).toEqual({ name: ["a name is required"] });
  });

  it("accepts a valid body (positive control)", () => {
    expect(parse(Rows, [{ name: "Security" }])).toEqual([{ name: "Security" }]);
  });
});
