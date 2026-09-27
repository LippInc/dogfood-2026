import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse, utcTime, utcTimeOrEmpty } from "@/server/dal/parse";
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

describe("utcTime", () => {
  it("reads the date picker's form and full ISO 8601 as the same UTC moment", () => {
    expect(utcTime.parse("2026-10-01T18:00")).toBe("2026-10-01T18:00:00.000Z");
    expect(utcTime.parse("2026-10-01T18:00Z")).toBe("2026-10-01T18:00:00.000Z");
    expect(utcTime.parse("2026-10-01T18:00:30.250Z")).toBe("2026-10-01T18:00:30.250Z");
    expect(utcTimeOrEmpty.parse("")).toBe("");
  });

  it("known-bad: a moment that does not exist, or another format, fails as a validation error with the expected format", () => {
    for (const bad of ["2026-13-45T10:00", "2026-02-30T10:00", "2026-04-01T24:00", "2026-10-01 18:00", "01/10/2026", "tomorrow", ""]) {
      const r = utcTime.safeParse(bad);
      expect(r.success, bad).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/UTC time such as 2026-10-01T18:00Z/);
    }
    expect(utcTimeOrEmpty.safeParse("2026-02-30T10:00").success).toBe(false);
  });
});
