import { describe, expect, it } from "vitest";
import { slugify } from "@/server/util";

// A web address part from a name. A name in Cyrillic, Chinese or Arabic gave "event" for every event (and every
// rubric criterion made from such a label), and the 60-character cut could leave a trailing hyphen.

describe("slugify", () => {
  it("keeps what it did for Latin names", () => {
    expect(slugify("Sample Hack 2026")).toBe("sample-hack-2026");
    expect(slugify("Café Déjà Vu!")).toBe("cafe-deja-vu");
  });

  it("known-bad: Cyrillic and Greek are spelt out instead of all becoming 'event'", () => {
    expect(slugify("Хакатон Таллинн")).toBe("khakaton-tallinn");
    expect(slugify("Κυπριακό Hackathon")).toBe("kypriako-hackathon");
    expect(slugify("Straße Łódź")).toBe("strasse-lodz");
  });

  it("known-bad: names with nothing Latin get a short suffix of their own, the same each time", () => {
    const a = slugify("黑客马拉松");
    const b = slugify("هاكاثون");
    expect(a).toMatch(/^event-[0-9a-f]{6}$/);
    expect(b).toMatch(/^event-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(slugify("黑客马拉松")).toBe(a);
    expect(slugify("★★★", "criterion-2")).toMatch(/^criterion-2-[0-9a-f]{6}$/);
  });

  it("known-bad: never ends in a hyphen after the 60-character cut", () => {
    const name = `${"a".repeat(59)} b`;
    const s = slugify(name);
    expect(s.endsWith("-")).toBe(false);
    expect(s.length).toBeLessThanOrEqual(60);
  });
});
