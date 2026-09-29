import { describe, expect, it, vi } from "vitest";
import { addTag, cleanTag, joinTags, removeTag, splitTags, suggestTags, TAG_LIMIT, TAG_LIST, TAG_MAX_LENGTH, tagProblem } from "@/lib/tags";
import { MAX_TAGS, MAX_TAG_LENGTH } from "@/server/project-limits";

// The save action is exercised with the data access layer stood in for: what matters here is that the one value
// the picker sends parses into exactly the chips it showed.
const createProject = vi.fn((..._args: unknown[]) => ({ status: "draft" }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/dal", () => ({
  actionError: (err: unknown) => ({ ok: false, message: String(err) }),
  createProject: (...args: unknown[]) => createProject(...args),
  createTeam: vi.fn(),
  currentActor: async () => ({ userId: "u1" }),
  dissolveTeam: vi.fn(),
  leaveTeam: vi.fn(),
  makeCaptain: vi.fn(),
  removeMember: vi.fn(),
  renameTeam: vi.fn(),
  rotateInvite: vi.fn(),
  updateProject: vi.fn(),
}));

describe("the tag list", () => {
  it("holds the server's limits", () => {
    expect(TAG_LIMIT).toBe(MAX_TAGS);
    expect(TAG_MAX_LENGTH).toBe(MAX_TAG_LENGTH);
  });

  it("is a big list, sorted without case, each tag once and within the server's rules", () => {
    expect(TAG_LIST.length).toBeGreaterThanOrEqual(250);
    expect(TAG_LIST.length).toBeLessThanOrEqual(400);
    const keys = TAG_LIST.map((t) => t.toLowerCase());
    expect(new Set(keys).size).toBe(TAG_LIST.length);
    expect([...TAG_LIST].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))).toEqual(TAG_LIST);
    for (const t of TAG_LIST) {
      expect(t).toBe(cleanTag(t));
      expect(t.includes(",")).toBe(false);
      expect(t.length).toBeLessThanOrEqual(MAX_TAG_LENGTH);
    }
    // the themes the brief names are in it
    for (const theme of ["Accessibility", "Sustainability", "Climate", "Education", "Health", "Fintech", "Open data", "Privacy", "Security"]) {
      expect(TAG_LIST).toContain(theme);
    }
  });
});

describe("adding and removing", () => {
  it("adds a tag trimmed, with inner space made one", () => {
    expect(addTag([], "  Machine   learning ")).toEqual(["Machine learning"]);
  });

  it("ignores a duplicate without regard to case", () => {
    expect(addTag(["Rust"], "rust")).toEqual(["Rust"]);
    expect(addTag(["Rust"], " RUST ")).toEqual(["Rust"]);
    expect(tagProblem("rust", ["Rust"])).toMatch(/picked already/);
  });

  it("adds nothing past the limit, and says so", () => {
    const eight = Array.from({ length: TAG_LIMIT }, (_, i) => `t${i}`);
    expect(addTag(eight, "one more")).toEqual(eight);
    expect(tagProblem("one more", eight)).toMatch(/8 tags is the most/);
    expect(addTag(eight.slice(1), "one more")).toHaveLength(TAG_LIMIT);
  });

  it("refuses a custom tag the server would refuse: a comma, or over the length limit", () => {
    expect(addTag([], "a, b")).toEqual([]);
    expect(tagProblem("a, b", [])).toMatch(/comma/);
    const long = "x".repeat(TAG_MAX_LENGTH + 1);
    expect(addTag([], long)).toEqual([]);
    expect(tagProblem(long, [])).toMatch(/at most 40/);
    expect(addTag([], "x".repeat(TAG_MAX_LENGTH))).toEqual(["x".repeat(TAG_MAX_LENGTH)]);
  });

  it("adds nothing for an empty or blank tag", () => {
    expect(addTag(["Go"], "   ")).toEqual(["Go"]);
    expect(tagProblem("  ", [])).toBeNull();
  });

  it("removes one tag without regard to case", () => {
    expect(removeTag(["Rust", "Go", "WebGPU"], "go")).toEqual(["Rust", "WebGPU"]);
  });
});

describe("the suggestions", () => {
  it("puts the tags other projects of the event carry first, in their spelling", () => {
    const out = suggestTags("", [], ["rust", "Our own thing"]);
    expect(out[0]).toEqual({ label: "rust", source: "event" });
    expect(out[1]).toEqual({ label: "Our own thing", source: "event" });
    // the list's own "Rust" is not offered a second time
    expect(out.filter((o) => o.label.toLowerCase() === "rust")).toHaveLength(1);
  });

  it("leaves out what is picked already", () => {
    expect(suggestTags("rus", ["Rust"], []).some((o) => o.label === "Rust")).toBe(false);
  });

  it("filters by what is typed, the tags that start with it first", () => {
    const out = suggestTags("script", [], []);
    const labels = out.map((o) => o.label);
    expect(labels).toContain("JavaScript");
    expect(labels).toContain("TypeScript");
    const re = suggestTags("re", [], []).map((o) => o.label);
    expect(re.indexOf("React")).toBeLessThan(re.indexOf("Firebase"));
    // a later word's start ranks before the middle of a word
    const learn = suggestTags("learn", [], []).map((o) => o.label);
    expect(learn[0]).toBe("Machine learning");
  });

  it("offers the typed tag itself last when nothing matches it exactly", () => {
    const out = suggestTags("rustacean", [], []);
    expect(out.at(-1)).toEqual({ label: "rustacean", source: "custom" });
    expect(suggestTags("rust", [], []).some((o) => o.source === "custom")).toBe(false);
    expect(suggestTags("RUST", [], []).some((o) => o.source === "custom")).toBe(false);
  });

  it("never offers a custom tag the server would refuse", () => {
    expect(suggestTags("a, b", [], []).some((o) => o.source === "custom")).toBe(false);
    expect(suggestTags("y".repeat(41), [], []).some((o) => o.source === "custom")).toBe(false);
  });
});

describe("the value the form sends", () => {
  it("round-trips through the save action's own split", () => {
    const chips = ["Rust", "Machine learning", "C#", "Next.js"];
    expect(joinTags(chips)).toBe("Rust, Machine learning, C#, Next.js");
    expect(splitTags(joinTags(chips))).toEqual(chips);
    expect(splitTags(joinTags([]))).toEqual([]);
  });

  it("is what the save action hands the data access layer, chip for chip", async () => {
    const { saveProjectAction } = await import("@/app/events/[event]/my-project/actions");
    const chips = ["Rust", "Machine learning", "C#", "human-computer-interaction"];
    const form = new FormData();
    form.set("event", "evt");
    form.set("project", "");
    form.set("intent", "draft");
    form.set("tags", joinTags(chips));
    const result = await saveProjectAction({ ok: false, message: null }, form);
    expect(result.ok).toBe(true);
    expect(createProject).toHaveBeenCalledTimes(1);
    const body = createProject.mock.calls[0]![2] as { tags: string[] };
    expect(body.tags).toEqual(chips);
  });
});
