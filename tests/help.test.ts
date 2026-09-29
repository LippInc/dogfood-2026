import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ask, canUse, HELP_ENTRIES, HELP_SUGGESTIONS, placesFor, resolveHref, suggestionsFor, type HelpRole } from "@/lib/help";
import { buildMatcher, MATCH_FLOOR, stem, tokens } from "@/lib/help/match";
import { helpKeyWanted } from "@/lib/help/key";

// The Help panel (src/components/help): its guide, its matcher, its key. The guide must be true of the portal,
// the matcher must find the entry a person means from the words they really type, and it must say "no match"
// rather than guess.

const everyRole = { signedIn: true, roles: ["organizer", "judge", "participant", "admin"] as HelpRole[] };
const visitor = { signedIn: false, roles: [] as HelpRole[] };
const top = (q: string, viewer = everyRole) => ask(q, viewer).matches[0]?.entry.id ?? "(no match)";

describe("the matcher finds the entry a question means", () => {
  // [question, expected top entry]: phrased the way people type, typos of grammar included
  const cases: [string, string][] = [
    ["where do i see votes", "voting-tab"],
    ["how publish", "publish"],
    ["what is the plus minus", "plus-minus"],
    ["who scored 4 4 4", "flat-judge"],
    ["why was a judge left out", "flat-judge"],
    ["what does ± mean next to the score", "plus-minus"],
    ["how are scores normalized", "leniency"],
    ["what is leniency", "leniency"],
    ["strict judges vs generous judges", "leniency"],
    ["is the ranking just random", "signal-check"],
    ["what is the permutation share", "signal-check"],
    ["how do i submit my project", "hand-in"],
    ["how to hand in", "hand-in"],
    ["invite teammates", "teams"],
    ["how do i vote", "vote"],
    ["what is a ballot", "ballots"],
    ["open link votes", "open-link"],
    ["can i see other judges scores", "other-judges"],
    ["keyboard shortcuts for judging", "judge-keys"],
    ["declare conflict of interest", "conflict"],
    ["which is better left or right", "pairwise-compare"],
    ["what is pairwise mode", "pairwise"],
    ["bradley terry", "pairwise"],
    ["audit log", "audit-tab"],
    ["what is the head hash", "audit-chain"],
    ["can results be changed after publishing", "freeze"],
    ["unpublish results", "freeze"],
    ["check a certificate is real", "verify"],
    ["issue certificates", "issue-records"],
    ["download csv", "exports"],
    ["import fixtures.json", "imports"],
    ["set up a webhook", "webhooks"],
    ["api token", "api-tokens"],
    ["rest api docs", "api-docs"],
    ["embed the gallery on our website", "embed"],
    ["merge duplicate project", "duplicates"],
    ["project with only one review", "under-reviewed"],
    ["invite judges", "invite-judges"],
    ["how are projects assigned to judges", "assignment"],
    ["change rubric weights", "weights"],
    ["add a co-organiser", "co-organizers"],
    ["forgot my password", "accounts"],
    ["create a new event", "new-event"],
    ["demo mode checker sessions", "demo-mode"],
    ["how do i back up the database", "backups"],
    ["dark mode", "mode"],
    ["what data do you keep about me", "privacy"],
    ["login", "sign-in"],
    ["too many requests 429", "rate-limits"],
    ["why do i get 403", "refusals"],
    ["where are the results", "results-public"],
    ["when is the deadline", "about"],
    ["my feedback from the judges", "my-feedback"],
    ["judge ledger", "judge-ledger"],
    ["ranking so far", "ranking-so-far"],
    ["remove a judge who accepted by mistake", "remove-judge"],
    ["reinstate the flat judge", "flat-judge"],
    ["override a judge with a reason", "exclude-judge"],
    ["switch to pairwise", "switch-pairwise"],
    ["docker compose up", "run-it"],
    ["settle the decisions", "decisions"],
  ];

  it(`answers ${cases.length} real questions with the expected entry first`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const wrong = cases.map(([q, id]) => ({ q, id, got: top(q) })).filter((c) => c.got !== c.id);
    expect(wrong).toEqual([]);
  });

  it("says no match for nonsense and for questions about something else, rather than guess", () => {
    for (const q of ["", "   ", "?!", "asdf qwerty", "banana bread recipe", "what is the weather in tallinn", "lorem ipsum dolor sit amet", "the", "zzzz"]) {
      const a = ask(q, everyRole);
      expect(a.matches, q).toEqual([]);
      expect(a.places.length, q).toBeGreaterThan(0);
    }
  });

  it("returns one to three matches, never more, each above the floor", () => {
    for (const [q] of cases.slice(0, 12)) {
      const m = ask(q, everyRole).matches;
      expect(m.length).toBeGreaterThanOrEqual(1);
      expect(m.length).toBeLessThanOrEqual(3);
    }
  });

  it("ranks what the person can do first among close matches, and still says who can do the rest", () => {
    // a judge asking where their scores are gets the console; a team member asking the same gets their project page
    expect(top("where are my scores", { signedIn: true, roles: ["judge"] })).toBe("judge-console");
    expect(top("where are my scores", { signedIn: true, roles: ["participant"] })).toBe("my-feedback");
    // a visitor asking to publish still gets the answer, marked as someone else's to use
    const pub = ask("how do i publish the results", visitor).matches.find((m) => m.entry.id === "publish")!;
    expect(pub).toBeDefined();
    expect(pub.usable).toBe(false);
    expect(ask("how do i publish the results", { signedIn: true, roles: ["organizer"] }).matches[0]!.usable).toBe(true);
  });

  it("drops the words that say nothing and stems the rest", () => {
    expect(tokens("Where do I see the votes?")).toContain("vot");
    expect(tokens("Where do I see the votes?")).not.toContain("where");
    expect(stem("scoring")).toBe(stem("scored"));
    expect(stem("judges")).toBe(stem("judging"));
    expect(tokens("4 / 4 / 4")).toEqual(["flatvector"]);
    expect(tokens("what's the ±")).toContain("plusminus");
    expect(tokens("École")).toEqual(["ecol"]);
  });

  it("the floor is what turns a weak match into no match (the instrument fails a known-bad)", () => {
    // one shared filler-ish word must not clear the floor
    const m = buildMatcher([{ id: "a", title: "Alpha page", keywords: ["alpha"], answer: "Alpha things." }, { id: "b", title: "Beta", keywords: [], answer: "Beta." }]);
    expect(m.score("gamma")).toEqual([]);
    expect(m.score("alpha")[0]!.id).toBe("a");
    expect(MATCH_FLOOR).toBeGreaterThan(0);
  });
});

describe("the suggestions", () => {
  it("each suggested question finds the entry it stands for", () => {
    for (const list of Object.values(HELP_SUGGESTIONS)) for (const s of list) expect(top(s.q), s.q).toBe(s.expect);
  });

  it("three to five for every kind of person, their own role first", () => {
    const people: { signedIn: boolean; roles: HelpRole[] }[] = [
      visitor,
      { signedIn: true, roles: [] },
      { signedIn: true, roles: ["participant"] },
      { signedIn: true, roles: ["judge"] },
      { signedIn: true, roles: ["organizer"] },
      { signedIn: true, roles: ["organizer", "admin"] },
      everyRole,
    ];
    for (const p of people) {
      const s = suggestionsFor(p);
      expect(s.length, JSON.stringify(p)).toBeGreaterThanOrEqual(3);
      expect(s.length).toBeLessThanOrEqual(5);
    }
    expect(suggestionsFor({ signedIn: true, roles: ["judge"] })[0]).toBe(HELP_SUGGESTIONS.judge[0]!.q);
    expect(suggestionsFor({ signedIn: true, roles: ["organizer", "judge"] }).slice(0, 2)).toEqual([HELP_SUGGESTIONS.organizer[0]!.q, HELP_SUGGESTIONS.judge[0]!.q]);
  });

  it("the places offered on no match are real entries, the person's own first", () => {
    expect(placesFor({ signedIn: true, roles: ["judge"] })[0]!.id).toBe("judge-console");
    expect(placesFor(visitor)[0]!.id).toBe("gallery");
  });
});

describe("the guide is true of the portal", () => {
  const root = process.cwd();
  const appDir = path.join(root, "src", "app");

  /** "/organize/[event]/audit" -> src/app/organize/[event]/audit/page.tsx or route.ts; "/" -> src/app/page.tsx */
  function routeFileFor(href: string): string | null {
    const clean = href.split(/[?#]/)[0]!;
    const dir = path.join(appDir, ...clean.split("/").filter(Boolean));
    for (const f of ["page.tsx", "route.ts"]) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    return null;
  }

  it("every href resolves to a route file under src/app", () => {
    const missing = HELP_ENTRIES.filter((e) => e.href && !routeFileFor(e.href)).map((e) => `${e.id}: ${e.href}`);
    expect(missing).toEqual([]);
    // and the check itself fails on a route that is not there
    expect(routeFileFor("/organize/[event]/nowhere")).toBeNull();
  });

  it("every audience is a real role (the schema's roles, anyone signed in, everyone, the administrators)", () => {
    const schema = fs.readFileSync(path.join(root, "src", "server", "db", "schema.ts"), "utf8");
    const roleLine = schema.match(/export const ROLES = \[([^\]]+)\]/)?.[1] ?? "";
    const schemaRoles = [...roleLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(schemaRoles.length).toBeGreaterThan(0);
    const allowed = new Set([...schemaRoles, "everyone", "signed-in", "admin"]);
    const bad = HELP_ENTRIES.flatMap((e) => e.who.filter((w) => !allowed.has(w)).map((w) => `${e.id}: ${w}`));
    expect(bad).toEqual([]);
    for (const e of HELP_ENTRIES) expect(e.who.length, e.id).toBeGreaterThan(0);
  });

  it("every doc heading it names exists in that file", () => {
    const bad = HELP_ENTRIES.filter((e) => e.doc).flatMap((e) => {
      const file = path.join(root, e.doc!.file);
      if (!fs.existsSync(file)) return [`${e.id}: no file ${e.doc!.file}`];
      const headings = fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^#{1,4} /.test(l))
        .map((l) => l.replace(/^#+ /, "").trim());
      return headings.includes(e.doc!.heading) ? [] : [`${e.id}: no heading "${e.doc!.heading}" in ${e.doc!.file}`];
    });
    expect(bad).toEqual([]);
  });

  it("ids are unique, answers are one or two short sentences, every entry has words people type", () => {
    const ids = HELP_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of HELP_ENTRIES) {
      expect(e.answer.length, e.id).toBeLessThanOrEqual(330);
      expect(e.keywords.length, e.id).toBeGreaterThan(0);
    }
  });

  it("covers every page a person can reach, the tour's tasks and the ideas a judge asks about", () => {
    const hrefs = new Set(HELP_ENTRIES.map((e) => e.href));
    for (const h of [
      "/",
      "/events/[event]",
      "/events/[event]/about",
      "/events/[event]/results",
      "/events/[event]/vote",
      "/events/[event]/my-project",
      "/judge/[event]",
      "/organize",
      "/organize/new",
      "/organize/accounts",
      "/organize/log",
      "/organize/[event]",
      "/organize/[event]/submissions",
      "/organize/[event]/judges",
      "/organize/[event]/voting",
      "/organize/[event]/results",
      "/organize/[event]/audit",
      "/organize/[event]/integrations",
      "/organize/[event]/settings",
      "/sign-in",
      "/sign-up",
      "/verify",
      "/privacy",
      "/api-docs",
      "/account/tokens",
    ])
      expect(hrefs.has(h), h).toBe(true);
    const ids = new Set(HELP_ENTRIES.map((e) => e.id));
    for (const id of ["decisions", "publish", "vote", "hand-in", "issue-records"]) expect(ids.has(id), id).toBe(true);
    for (const id of ["leniency", "plus-minus", "flat-judge", "signal-check", "pairwise", "audit-chain", "freeze", "ballots", "open-link", "demo-mode", "backups", "api"])
      expect(ids.has(id), id).toBe(true);
  });

  it("links fill in the event in view, and link nothing when no event is known", () => {
    const overview = HELP_ENTRIES.find((e) => e.id === "overview")!;
    expect(resolveHref(overview, { slug: "sample-hack-2026", name: "Sample Hack 2026" })).toBe("/organize/sample-hack-2026");
    expect(resolveHref(overview, null)).toBeNull();
    expect(resolveHref(HELP_ENTRIES.find((e) => e.id === "verify")!, null)).toBe("/verify");
  });

  it("an administrator can use what organizers can; a visitor cannot use what needs an account", () => {
    const overview = HELP_ENTRIES.find((e) => e.id === "overview")!;
    expect(canUse(overview, { signedIn: true, roles: ["admin"] })).toBe(true);
    expect(canUse(overview, { signedIn: true, roles: ["judge"] })).toBe(false);
    expect(canUse(HELP_ENTRIES.find((e) => e.id === "vote")!, visitor)).toBe(false);
    expect(canUse(HELP_ENTRIES.find((e) => e.id === "vote")!, { signedIn: true, roles: [] })).toBe(true);
  });
});

describe("the ? key", () => {
  const page = (own = false, dialogOpen = false) => ({
    querySelector: (sel: string) => (sel.includes("data-question-key") ? (own ? {} : null) : dialogOpen ? {} : null),
  });
  const key = (over: Partial<{ key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; defaultPrevented: boolean; repeat: boolean; target: unknown }> = {}) => ({
    key: "?",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    repeat: false,
    target: { closest: () => null },
    ...over,
  });

  it("opens Help on an ordinary page", () => {
    expect(helpKeyWanted(key(), page(), true)).toBe(true);
  });

  it("does not steal the judge console's or the compare page's own ?", () => {
    expect(helpKeyWanted(key(), page(true), true)).toBe(false);
    // both pages claim ? on the root they draw, the working screen and the empty one alike
    const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
    const console = read("src/app/judge/[event]/console.tsx");
    const compare = read("src/app/judge/[event]/compare.tsx");
    expect(console).toMatch(/<div data-question-key className="grid grid-cols-\[minmax\(0,1fr\)\] lg:h-/);
    expect(console).toMatch(/<div data-question-key className="mx-auto max-w-\[680px\]/);
    expect(compare).toMatch(/<div data-question-key className="grid grid-cols-\[minmax\(0,1fr\)\] lg:h-/);
    expect(compare).toMatch(/<div data-question-key className="mx-auto max-w-\[680px\]/);
    // and the judge pages' top bar does not bind the key at all
    expect(read("src/components/shell/work-shell.tsx")).toMatch(/<HelpSlot [^>]*questionKey=\{role !== "Judge"\}/);
    const judgePage = read("src/app/judge/[event]/page.tsx");
    expect(judgePage.match(/role="Judge"/g)?.length).toBe(2);
  });

  it("never fires while typing, with a modifier, inside another dialog, when handled already, or when turned off", () => {
    expect(helpKeyWanted(key({ target: { closest: () => ({}) } }), page(), true)).toBe(false);
    expect(helpKeyWanted(key({ ctrlKey: true }), page(), true)).toBe(false);
    expect(helpKeyWanted(key({ altKey: true }), page(), true)).toBe(false);
    expect(helpKeyWanted(key({ metaKey: true }), page(), true)).toBe(false);
    expect(helpKeyWanted(key({ defaultPrevented: true }), page(), true)).toBe(false);
    expect(helpKeyWanted(key({ repeat: true }), page(), true)).toBe(false);
    expect(helpKeyWanted(key(), page(false, true), true)).toBe(false);
    expect(helpKeyWanted(key(), page(), false)).toBe(false);
    expect(helpKeyWanted(key({ key: "/" }), page(), true)).toBe(false);
  });
});

describe("no network", () => {
  it("the panel and its guide make no request of their own: no fetch, beacon, socket, dynamic import or server action", () => {
    const files = [
      "src/lib/help/index.ts",
      "src/lib/help/match.ts",
      "src/lib/help/key.ts",
      ...fs.readdirSync(path.join(process.cwd(), "src/components/help")).map((f) => `src/components/help/${f}`),
    ];
    for (const f of files) {
      const text = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      // the client files: no way out of the page
      if (!f.endsWith("help-slot.tsx")) {
        expect(text, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(|"use server"|@\/server|\/actions["']/);
      }
      // an answer's links do not prefetch their pages (Next's Link would load each one it shows)
      const links = text.match(/<Link\b/g)?.length ?? 0;
      expect(text.match(/prefetch=\{false\}/g)?.length ?? 0, f).toBe(links);
    }
  });
});
