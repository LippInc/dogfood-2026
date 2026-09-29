import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fold, hasTag, projectMatches, searchText, searchWords, tagCounts } from "@/lib/search";
import { getGallery, searchGallery } from "@/server/dal/events";
import { GalleryBrowser, type BrowserItem } from "@/components/gallery/gallery-browser";
import { expectHttpError, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The gallery's tag filter and its search of summaries and write-ups (judge's-eye reading 10, criterion 1: "a track
// filter but no tag filter, and search skips the summary and description"). The same rules in the browser and at
// GET /api/events/{event}/projects?q=&track=&tag=.

withFixtureEvent();

const { GET } = await import("@/app/api/events/[event]/projects/route");

type Answer = { status: number; body: { projects?: Record<string, unknown>[]; error?: string } };
async function api(query: string): Promise<Answer> {
  const res = await GET(new Request(`http://localhost:8080/api/events/evt_01/projects${query}`), { params: Promise.resolve({ event: "evt_01" }) });
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}
const ids = (a: Answer) => a.body.projects!.map((p) => p.id);

describe("search reads summaries and write-ups", () => {
  it("a word only in a project's summary finds it", async () => {
    sqlRun("UPDATE projects SET summary = 'Routes ferries around the Zanzibar strait' WHERE id = 'prj_01'");
    expect(ids(await api("?q=zanzibar"))).toEqual(["prj_01"]);
  });

  it("a word only in a project's write-up finds it, accents and case ignored, and the answer does not carry the write-up's word list", async () => {
    sqlRun("UPDATE projects SET description = 'We trained on the Québec Ferry logs.' WHERE id = 'prj_02'");
    const found = await api("?q=QUEBEC%20ferry");
    expect(ids(found)).toEqual(["prj_02"]);
    expect(found.body.projects![0]).not.toHaveProperty("text");
    expect(found.body.projects![0]).not.toHaveProperty("description");
  });

  it("a write-up the organizers hide is not searched", async () => {
    sqlRun("UPDATE projects SET description = 'kilimanjaro' WHERE id = 'prj_03'");
    expect(ids(await api("?q=kilimanjaro"))).toEqual(["prj_03"]); // positive control
    sqlRun("INSERT INTO project_fields (event_id, field, mode) VALUES ('evt_01', 'description', 'hidden')");
    expect(ids(await api("?q=kilimanjaro"))).toEqual([]);
  });

  it("a hidden summary is not searched either", async () => {
    sqlRun("UPDATE projects SET summary = 'serengeti' WHERE id = 'prj_04'");
    expect(ids(await api("?q=serengeti"))).toEqual(["prj_04"]);
    sqlRun("INSERT INTO project_fields (event_id, field, mode) VALUES ('evt_01', 'summary', 'hidden')");
    expect(ids(await api("?q=serengeti"))).toEqual([]);
  });

  it("the write-up's word list finds exactly what the whole text finds", () => {
    const text = "Ünïcode   rules,\nand re-use: école-first!  École again";
    const compact = searchText(text);
    expect(compact.length).toBeLessThan(fold(text).length);
    for (const q of ["unicode", "rules,", "re-use", "ecole-first", "cole", "first!", "again", "use:", "rules and", "zz", "ecole again"]) {
      const words = searchWords(q);
      const whole = words.every((w) => fold(text).includes(w));
      expect(projectMatches({ id: "p", title: "", teamName: "", trackName: "", tags: [], text: compact }, words), q).toBe(whole);
    }
  });

  it("only the gallery page and the search read write-ups: plain getGallery leaves them out", () => {
    sqlRun("UPDATE projects SET description = 'kilimanjaro' WHERE id = 'prj_03'");
    expect(getGallery("evt_01").projects.find((p) => p.id === "prj_03")).not.toHaveProperty("text");
    expect(getGallery("evt_01", { withText: true }).projects.find((p) => p.id === "prj_03")?.text).toBe("kilimanjaro");
  });
});

describe("the tag filter", () => {
  const tag = (id: string, tags: string[]) => sqlRun("UPDATE projects SET tags = ? WHERE id = ?", JSON.stringify(tags), id);

  it("keeps the projects carrying the tag, case and accents ignored", async () => {
    tag("prj_01", ["Rust", "WebGPU"]);
    tag("prj_02", ["rust"]);
    tag("prj_05", ["Python"]);
    expect(ids(await api("?tag=RUST")).sort()).toEqual(["prj_01", "prj_02"]);
    expect(ids(await api("?tag=webgpu"))).toEqual(["prj_01"]);
    // a tag is a whole tag, not a word inside one
    expect(ids(await api("?tag=Rus"))).toEqual([]);
    // positive control: without a tag, every project
    expect(ids(await api("")).length).toBeGreaterThan(20);
  });

  it("combines with the track and the search", async () => {
    tag("prj_01", ["Rust"]); // trk_04
    tag("prj_02", ["Rust"]); // trk_03
    sqlRun("UPDATE projects SET summary = 'ferry planner' WHERE id IN ('prj_01', 'prj_02')");
    expect(ids(await api("?tag=rust&track=trk_04"))).toEqual(["prj_01"]);
    expect(ids(await api("?tag=rust&q=ferry")).sort()).toEqual(["prj_01", "prj_02"]);
    expect(ids(await api("?tag=rust&q=ferry&track=trk_03"))).toEqual(["prj_02"]);
    expect(ids(await api("?tag=python&q=ferry"))).toEqual([]);
  });

  it("a tag no project carries keeps none; an overlong one is 422 naming the field", async () => {
    expect(await api("?tag=cobol")).toMatchObject({ status: 200, body: { projects: [] } });
    const long = await api(`?tag=${"a".repeat(61)}`);
    expect(long).toMatchObject({ status: 422, body: { error: "invalid" } });
    expectHttpError(() => searchGallery("evt_01", { tag: "a".repeat(61) }), 422, "invalid");
  });

  it("hidden tags filter nothing", async () => {
    tag("prj_01", ["Rust"]);
    expect(ids(await api("?tag=rust"))).toEqual(["prj_01"]);
    sqlRun("INSERT INTO project_fields (event_id, field, mode) VALUES ('evt_01', 'tags', 'hidden')");
    expect(ids(await api("?tag=rust"))).toEqual([]);
  });

  it("counts each tag once per project, under its most used spelling, the most carried first", () => {
    const list = [{ tags: ["Rust", "rust "] }, { tags: ["rust"] }, { tags: ["rust", "Go"] }, { tags: [] }];
    expect(tagCounts(list)).toEqual([
      { key: "rust", label: "rust", count: 3 },
      { key: "go", label: "Go", count: 1 },
    ]);
    expect(hasTag({ tags: ["Rúst"] }, "rust")).toBe(true);
    expect(hasTag({ tags: ["Rust"] }, null)).toBe(true);
    expect(hasTag({ tags: [] }, "rust")).toBe(false);
  });
});

describe("the gallery's first paint with a tag in the link", () => {
  const item = (id: string, title: string, tags: string[]): BrowserItem => ({
    id,
    title,
    summary: "",
    teamName: `Team ${id}`,
    trackId: "trk_a",
    trackName: "Track A",
    tags,
    text: "",
  });
  const items = [item("p1", "Alpha Ferry", ["Rust"]), item("p2", "Beta Kite", ["Python"]), item("p3", "Gamma Loom", [])];
  const draw = (initialTag: string | null) =>
    renderToStaticMarkup(
      h(GalleryBrowser, {
        eventSlug: "e",
        items,
        tracks: [{ id: "trk_a", name: "Track A", count: 3 }],
        tileFaces: {},
        smallFaces: {},
        initialTrack: null,
        initialQuery: "",
        initialTag,
      }),
    );

  // the grid under the controls; the Field above keeps every face and fades the rest back
  const grid = (html: string) => html.slice(html.lastIndexOf('<ul class="grid'));

  it("?tag=rust draws only the projects carrying it, and the filter shows the tag chosen", () => {
    const html = draw("RUST");
    expect(grid(html)).toContain("Alpha Ferry");
    expect(grid(html)).not.toContain("Beta Kite");
    expect(grid(html)).not.toContain("Gamma Loom");
    expect(html).toContain("1 of 3</span> tagged Rust. The rest fade back.");
    expect(html).toMatch(/<option value="rust" selected="">Rust \(1\)<\/option>/);
  });

  it("positive control: no tag, or one no project carries, draws every project", () => {
    for (const t of [null, "cobol"]) {
      const html = grid(draw(t));
      for (const title of ["Alpha Ferry", "Beta Kite", "Gamma Loom"]) expect(html).toContain(title);
    }
  });

  it("no filter at all when no project carries a tag", () => {
    const html = renderToStaticMarkup(
      h(GalleryBrowser, {
        eventSlug: "e",
        items: items.map((i) => ({ ...i, tags: [] })),
        tracks: [{ id: "trk_a", name: "Track A", count: 3 }],
        tileFaces: {},
        smallFaces: {},
        initialTrack: null,
        initialQuery: "",
      }),
    );
    expect(html).not.toContain(">Tag<");
    expect(draw(null)).toContain(">Tag<");
  });
});
