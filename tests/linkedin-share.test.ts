import { describe, expect, it } from "vitest";
import { linkedInAddHref, linkedInCertName } from "@/lib/linkedin";

describe("the Add to LinkedIn link on a certificate", () => {
  const href = linkedInAddHref({
    name: "1st place, Health: Pizza Tracker",
    organization: "Sample Hack & Friends 2026",
    issuedAt: "2026-12-31T23:30:00.000Z",
    url: "http://localhost:8080/records/rec_01",
    id: "rec_01",
  });
  const u = new URL(href);

  it("opens LinkedIn's add-certification form, prefilled with the record's facts", () => {
    expect(u.origin + u.pathname).toBe("https://www.linkedin.com/profile/add");
    expect(u.searchParams.get("startTask")).toBe("CERTIFICATION_NAME");
    expect(u.searchParams.get("name")).toBe("1st place, Health: Pizza Tracker");
    expect(u.searchParams.get("organizationName")).toBe("Sample Hack & Friends 2026");
    expect(u.searchParams.has("organizationId")).toBe(false);
    expect(u.searchParams.get("certUrl")).toBe("http://localhost:8080/records/rec_01");
    expect(u.searchParams.get("certId")).toBe("rec_01");
  });

  it("dates it in UTC (a record issued late on 31 December is December, not January)", () => {
    expect(u.searchParams.get("issueYear")).toBe("2026");
    expect(u.searchParams.get("issueMonth")).toBe("12");
  });

  it("keeps the event name whole: an ampersand does not cut the query", () => {
    expect(href).toContain("organizationName=Sample+Hack+%26+Friends+2026");
  });

  it("leaves the date out rather than send NaN", () => {
    const bad = new URL(linkedInAddHref({ name: "x", organization: "y", issuedAt: "not a date", url: "http://h/records/r", id: "r" }));
    expect(bad.searchParams.has("issueYear")).toBe(false);
    expect(href).not.toContain("NaN");
  });

  it("names the record by its award, else by the part played", () => {
    expect(linkedInCertName({ kind: "participant", awards: ["1st place, Health"], projectTitle: "Pizza Tracker" })).toBe("1st place, Health: Pizza Tracker");
    expect(linkedInCertName({ kind: "participant", awards: [], projectTitle: "Pizza Tracker" })).toBe("Participant: Pizza Tracker");
    expect(linkedInCertName({ kind: "judge" })).toBe("Judge");
  });
});
