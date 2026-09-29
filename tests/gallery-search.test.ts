import { describe, expect, it } from "vitest";
import { fold, matchRanges, projectMatches, searchWords } from "@/lib/search";
import { searchGallery } from "@/server/dal/events";
import { expectHttpError, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The gallery's search, in the browser and at GET /api/events/{event}/projects?q=&track=: every word must appear in a
// project's title, team, track, id or tags (or its summary or write-up: gallery-tags-writeups.test.ts), with case and
// accents folded away, so "ecole" finds "École".

withFixtureEvent();

const { GET } = await import("@/app/api/events/[event]/projects/route");

async function api(query: string) {
  const res = await GET(new Request(`http://localhost:8080/api/events/evt_01/projects${query}`), { params: Promise.resolve({ event: "evt_01" }) });
  return { status: res.status, body: (await res.json()) as { projects?: { id: string }[]; error?: string } };
}

describe("folding and matching", () => {
  it("case and accents fold away, in precomposed and decomposed text alike", () => {
    expect(fold("École Müller ÅSE")).toBe("ecole muller ase");
    expect(fold("École")).toBe("ecole");
    expect(searchWords("  Ecole   MÜLLER ")).toEqual(["ecole", "muller"]);
    const p = { id: "prj_x", title: "École du Nord", teamName: "Müller & Søn", trackName: "Climate", tags: ["Rust"] };
    expect(projectMatches(p, searchWords("ecole muller"))).toBe(true);
    expect(projectMatches(p, searchWords("ÉCOLE rust"))).toBe(true);
    expect(projectMatches(p, searchWords("ecole python"))).toBe(false); // every word, not any
    expect(projectMatches(p, [])).toBe(true);
  });

  it("a highlight lands on the original letters, however folding changed the length", () => {
    expect(matchRanges("École du Nord", ["ecole"])).toEqual([[0, 5]]);
    expect(matchRanges("École", ["ecole"])).toEqual([[0, 6]]); // the combining accent is marked with its letter
    expect(matchRanges("Müller Mueller", ["muller"])).toEqual([[0, 6]]);
    expect(matchRanges("abc", ["zz"])).toEqual([]);
  });
});

describe("GET /api/events/{event}/projects?q=&track=", () => {
  it("with neither, every submitted project, as before", async () => {
    const all = await api("");
    expect(all.status).toBe(200);
    expect(all.body.projects!.length).toBe(searchGallery("evt_01", {}).projects.length);
    expect(all.body.projects!.length).toBeGreaterThan(20);
  });

  it("q narrows to the projects every word finds, ignoring case and accents", async () => {
    sqlRun("UPDATE projects SET title = 'École Glass Signal' WHERE id = 'prj_01'");
    const found = await api("?q=ECOLE%20glass");
    expect(found.status).toBe(200);
    expect(found.body.projects!.map((p) => p.id)).toEqual(["prj_01"]);
    expect((await api("?q=ecole%20nothing-like-this")).body.projects).toEqual([]);
  });

  it("track keeps one track's projects, and combines with q", async () => {
    const security = await api("?track=trk_04");
    expect(security.status).toBe(200);
    const ids = security.body.projects!.map((p) => p.id);
    expect(ids).toContain("prj_01");
    expect(ids).not.toContain("prj_02"); // trk_03
    expect(ids.length).toBeLessThan(searchGallery("evt_01", {}).projects.length);
    expect((await api("?track=trk_03&q=glass%20signal")).body.projects).toEqual([]);
  });

  it("a track the event does not have, or an overlong q, is 422 naming the field", async () => {
    const bad = await api("?track=trk_nope");
    expect(bad).toMatchObject({ status: 422, body: { error: "invalid" } });
    expect((await api(`?q=${"a".repeat(201)}`)).status).toBe(422);
    expectHttpError(() => searchGallery("evt_01", { track: "trk_nope" }), 422, "invalid");
  });

  it("a field the organizers hide is not searched: hidden tags find nothing", async () => {
    sqlRun("UPDATE projects SET tags = '[\"zanzibar\"]' WHERE id = 'prj_01'");
    expect((await api("?q=zanzibar")).body.projects!.map((p) => p.id)).toEqual(["prj_01"]);
    sqlRun("INSERT INTO project_fields (event_id, field, mode) VALUES ('evt_01', 'tags', 'hidden')");
    expect((await api("?q=zanzibar")).body.projects).toEqual([]);
  });
});
