import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accessLabel, ask, canUse, HELP_ENTRIES, HELP_SUGGESTIONS, placesFor, reach, resolveHref, suggestionsFor, type HelpEntry, type HelpRole } from "@/lib/help";
import { buildMatcher, MATCH_FLOOR, stem, tokens, WORD_SHARE_FLOOR } from "@/lib/help/match";
import { helpKeyWanted, ownsHelpKey } from "@/lib/help/key";

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

describe("the second review: rank, labels, no confident wrong answers", () => {
  const participant = { signedIn: true, roles: ["participant"] as HelpRole[] };
  const organizer = { signedIn: true, roles: ["organizer"] as HelpRole[] };
  const judge = { signedIn: true, roles: ["judge"] as HelpRole[] };
  const ids = (q: string, viewer: { signedIn: boolean; roles: HelpRole[] }) => ask(q, viewer).matches.map((m) => m.entry.id);

  it("ranks what the signed-in person can do first: a team member asking to rename the team gets the team page, not the organizers' tool", () => {
    // before: "Change a team after the close" (organizers only) came first for a team member and a visitor
    expect(top("how to change team name", participant)).toBe("teams");
    expect(top("how to change team name", visitor)).toBe("teams");
    expect(ask("how to change team name", participant).matches[0]!.usable).toBe(true);
    // the organizers' tool is still offered to the team member, marked as theirs
    const other = ask("how to change team name", participant).matches.find((m) => m.entry.id === "team-organizer");
    expect(other?.usable).toBe(false);
    // positive control: an organizer can use both, and the text decides
    expect(ids("how to change team name", organizer).slice(0, 2).sort()).toEqual(["team-organizer", "teams"]);
  });

  it("puts a close match the person can do before one they cannot, and never lets a weak one jump a strong one", () => {
    // a judge and a team member asking the same words get their own page first
    expect(top("where are my scores", judge)).toBe("judge-console");
    expect(top("where are my scores", participant)).toBe("my-feedback");
    // a visitor asking how to publish gets the organizers' answer among the first, marked as not theirs
    const pub = ask("how do i publish the results", visitor).matches.find((m) => m.entry.id === "publish")!;
    expect(pub.usable).toBe(false);
    // the only strong answer stays first for a visitor, however many weak ones they could use
    expect(top("how many judges per project", visitor)).toBe("reviews-per-project");
    expect(top("how many judges per project", organizer)).toBe("reviews-per-project");
  });

  it("labels every answer in plain words for the person reading it", () => {
    const entry = (who: HelpEntry["who"]) => ({ who });
    const cases: [HelpEntry["who"], { signedIn: boolean; roles: HelpRole[] }, string][] = [
      [["everyone"], visitor, "Everyone"],
      [["everyone"], organizer, "Everyone"],
      [["signed-in"], visitor, "Sign in to do this"],
      [["signed-in"], participant, "Anyone signed in"],
      [["signed-in", "participant"], visitor, "Sign in to do this"],
      [["signed-in", "participant"], judge, "Anyone signed in"],
      [["signed-in", "organizer"], visitor, "Sign in to do this"],
      [["participant"], visitor, "Team members only"],
      [["participant"], judge, "Team members only"],
      [["participant"], participant, "Team members"],
      [["judge"], participant, "Judges only"],
      [["judge"], judge, "Judges"],
      [["organizer"], visitor, "Organizers only"],
      [["organizer"], participant, "Organizers only"],
      [["organizer"], organizer, "Organizers"],
      [["organizer"], { signedIn: true, roles: ["admin"] }, "Organizers"],
      [["organizer", "admin"], judge, "Organizers and administrators only"],
      [["admin"], organizer, "Administrators only"],
      [["judge", "organizer"], participant, "Judges and organizers only"],
      [["judge", "organizer"], judge, "Judges and organizers"],
      [["participant", "judge"], organizer, "Team members and judges only"],
    ];
    for (const [who, viewer, label] of cases) expect(accessLabel(entry(who), viewer), `${who.join("+")} for ${JSON.stringify(viewer)}`).toBe(label);
    // every entry of the guide gets a label without "only anyone" or "only everyone", for every kind of person
    for (const e of HELP_ENTRIES)
      for (const v of [visitor, participant, judge, organizer, everyRole]) {
        const l = accessLabel(e, v);
        expect(l, e.id).not.toMatch(/only (anyone|everyone)|anyone signed in only|everyone only/i);
        expect(reach(e, v) === 0, `${e.id}: ${l}`).toBe(!/only$|^Sign in/.test(l));
      }
  });

  it("the stemmer never merges two different words of the guide", () => {
    expect(stem("tracking")).not.toBe(stem("track"));
    expect(stem("tracks")).toBe(stem("track"));
    expect(stem("site")).not.toBe(stem("sit"));
    expect(stem("theme")).not.toBe(stem("them"));
    expect(stem("standings")).not.toBe(stem("stands"));
    expect(stem("rights")).not.toBe(stem("right"));
    // every word of the guide that shares a stem with another: each group is one word's forms
    const groups = new Map<string, Set<string>>();
    for (const e of HELP_ENTRIES)
      for (const w of [e.title, e.answer, ...e.keywords].join(" ").toLowerCase().normalize("NFD").split(/[^a-z0-9]+/)) {
        if (!w) continue;
        const s = stem(w);
        if (!groups.has(s)) groups.set(s, new Set());
        groups.get(s)!.add(w);
      }
    const merged = [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort().join(" "));
    for (const bad of ["track tracking", "site sit", "them theme", "standings stands", "right rights"])
      expect(merged.some((g) => bad.split(" ").every((w) => g.split(" ").includes(w))), bad).toBe(false);
  });

  it("answers the review's questions and the gaps it found", () => {
    const cases: [string, string][] = [
      ["what is a track", "tracks"],
      ["what tracks are there", "tracks"],
      ["what is a category", "tracks"],
      ["how do i sign out", "sign-out"],
      ["how do i log out", "sign-out"],
      ["how do i switch accounts", "sign-out"],
      ["how many judges per project", "reviews-per-project"],
      ["who decides the number of judges per project", "reviews-per-project"],
      ["how do i become an organizer", "become-organizer"],
      ["how do i get organizer access", "become-organizer"],
      ["make me an organizer", "become-organizer"],
      ["how many people per team", "teams"],
      ["who can see my email", "privacy"],
      ["how do i delete my account", "privacy"],
    ];
    const wrong = cases.map(([q, id]) => ({ q, id, got: top(q, visitor) })).filter((c) => c.got !== c.id);
    expect(wrong).toEqual([]);
    // the three the review caught guessing: none of them lands on its old wrong answer
    expect(top("how many judges per project", visitor)).not.toBe("ballots");
    expect(top("how do i become an organizer", visitor)).not.toBe("judge-invite");
    expect(top("what is a track", visitor)).not.toBe("privacy");
  });

  it("says no match, rather than guess, for realistic questions the guide does not answer", () => {
    const misses = [
      "can i pay with a credit card",
      "how do i contact the organizers",
      "is there a mobile app",
      "what languages are supported",
      "who won last year",
      "can two teams merge",
      "how do i report a bug",
      "is there a chat",
      "how big can my picture be",
      "where do i upload slides",
      "how do i book a flight",
      "can i bring my dog",
      "recipe for pancakes",
      "can i submit a video",
      "what is the wifi password",
      "where is the venue",
      "is lunch provided",
      "how do i get a refund",
      // the portal has no way to change one's own email address or name (FEATURES.md, README.md)
      "can i change my email address",
      "how do i change my name",
      "how do i change my email",
    ];
    expect(misses.length).toBeGreaterThanOrEqual(20);
    for (const v of [visitor, participant, organizer]) {
      const guessed = misses.filter((q) => ask(q, v).matches.length > 0).map((q) => `${q} -> ${top(q, v)}`);
      expect(guessed, JSON.stringify(v)).toEqual([]);
    }
  });

  it("the word-share floor is what turns a one-word overlap into no match (the instrument fails a known-bad)", () => {
    // one rare shared word ("become") used to carry the question to the judges' invitation
    const m = buildMatcher([
      { id: "a", title: "Accept an invitation", keywords: ["become a judge"], answer: "Open the link." },
      { id: "b", title: "Beta", keywords: [], answer: "Beta." },
    ]);
    const [hit] = m.score("become organizer");
    expect(hit?.id).toBe("a");
    expect(hit!.wordShare).toBeLessThan(WORD_SHARE_FLOOR);
    expect(m.score("become a judge")[0]!.wordShare).toBeGreaterThanOrEqual(WORD_SHARE_FLOOR);
  });

  it("says both cases of email, true with SMTP_URL set and without it", () => {
    for (const id of ["accounts", "invite-judges"]) {
      const a = HELP_ENTRIES.find((e) => e.id === id)!.answer;
      expect(a, id).toMatch(/SMTP_URL/);
      expect(a, id).toMatch(/email off/);
      expect(a, id).not.toMatch(/sends no email|no mail server is needed/i);
    }
  });
});

describe("the third pass: partial hits count for less, strong matches stay first", () => {
  const readers: [string, { signedIn: boolean; roles: HelpRole[] }][] = [
    ["visitor", visitor],
    ["participant", { signedIn: true, roles: ["participant"] }],
    ["judge", { signedIn: true, roles: ["judge"] }],
    ["organizer", { signedIn: true, roles: ["organizer"] }],
  ];

  it("answers the second review's questions, for every reader, with the entry that answers them", () => {
    const cases: [string, string][] = [
      ["when does judging end", "judging-close"],
      ["what time does judging close", "judging-close"],
      ["change password", "change-password"],
      ["how do i change my password", "change-password"],
      ["how are projects scored", "how-scored"],
      ["how many judges per project", "reviews-per-project"],
      ["where is the logout button", "sign-out"],
      ["is my activity tracked", "privacy"],
    ];
    const wrong: string[] = [];
    for (const [name, v] of readers) for (const [q, id] of cases) if (top(q, v) !== id) wrong.push(`${name}: ${q} -> ${top(q, v)}`);
    expect(wrong).toEqual([]);
    // "can i judge my own project": the rule that keeps a judge off their own team, never the judge console or the
    // organizers' count of judges
    for (const [name, v] of readers) expect(["assignment", "conflict"], `${name}`).toContain(top("can i judge my own project", v));
  });

  it("answers realistic questions from each kind of reader, or says no match where the portal has no answer", () => {
    // each expectation checked against the code: the entry's answer is true of the page it names
    const cases: [string, string][] = [
      // visitors
      ["how do i sign up", "sign-up"],
      ["how do i verify a certificate", "verify"],
      ["what is demo mode", "demo-mode"],
      ["how do i run it with docker", "run-it"],
      ["is there an api", "api"],
      ["when are results published", "results-public"],
      ["forgot my password", "change-password"],
      // participants
      ["how do i join a team", "teams"],
      ["how do i leave my team", "teams"],
      ["can i edit my project after submitting", "hand-in"],
      ["how many projects can i vote for", "vote"],
      ["can i vote for my own team", "vote"],
      ["can i delete my account", "privacy"],
      ["how do i make an api token", "api-tokens"],
      // judges
      ["where is the judge console", "judge-console"],
      ["can judges see each other's scores", "other-judges"],
      ["where do i declare a conflict", "conflict"],
      ["what is the flat judge rule", "flat-judge"],
      ["what does the signal check mean", "signal-check"],
      // organizers
      ["how do i add a co-organizer", "co-organizers"],
      ["how do i change the rubric weights", "weights"],
      ["where do i export scores", "exports"],
      ["how do i back up the portal", "backups"],
      ["how do i switch to pairwise", "switch-pairwise"],
      ["how do i import fixtures", "imports"],
      ["how do i embed the gallery", "embed"],
      ["how do i set the judging close time", "judging-close"],
      ["what is the audit log", "audit-tab"],
      ["how do i create an event", "new-event"],
      ["change the team name", "teams"],
    ];
    expect(cases.length).toBeGreaterThanOrEqual(25);
    const wrong = cases.map(([q, id]) => ({ q, id, got: top(q, visitor) })).filter((c) => c.got !== c.id);
    expect(wrong).toEqual([]);
    const misses = ["can i change my email address", "how do i change my name", "can i rename my account"];
    for (const [name, v] of readers) expect(misses.filter((q) => ask(q, v).matches.length), name).toEqual([]);
  });

  it("a synonym or an answer-only hit covers only part of a word (the instrument fails a known-bad)", () => {
    // the review's case: "judging" only in the running text, "end" in a keyword, used to count as the whole question
    const m = buildMatcher([
      { id: "out", title: "Sign out", keywords: ["end session"], answer: "It is in the top bar on the judging pages." },
      { id: "vote", title: "Vote", keywords: ["ballot"], answer: "Pick three." },
      { id: "x", title: "Unrelated", keywords: ["other"], answer: "Nothing." },
    ]);
    const out = m.score("when does judging end").find((s) => s.id === "out")!;
    expect(out.wordShare).toBeLessThan(WORD_SHARE_FLOOR);
    // a synonym hit ("favourite" stands for "ballot") covers half a word, never the whole
    const fav = m.score("favourite ballot").find((s) => s.id === "vote")!;
    const named = m.score("vote ballot").find((s) => s.id === "vote")!;
    expect(fav.wordShare).toBeLessThan(1);
    expect(named.wordShare).toBe(1);
    // positive control: the words in the title and keywords cover the question whole
    expect(m.score("sign out end session").find((s) => s.id === "out")!.wordShare).toBe(1);
  });

  it("keeps a strong match the reader cannot use above weaker ones they can (the old ranking fails this)", () => {
    const judge = { signedIn: true, roles: ["judge"] as HelpRole[] };
    const a = ask("how many judges per project", judge);
    expect(a.matches[0]!.entry.id).toBe("reviews-per-project");
    expect(a.matches[0]!.usable).toBe(false);
    // what the judge can do still comes first among truly close matches (positive control)
    expect(top("how to change team name", { signedIn: true, roles: ["participant"] })).toBe("teams");
  });

  it("an administrator with no event roles gets three to five suggestions, each finding its entry", () => {
    const s = suggestionsFor({ signedIn: true, roles: ["admin"] });
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.length).toBeLessThanOrEqual(5);
    for (const { q, expect: id } of HELP_SUGGESTIONS.admin) expect(top(q, { signedIn: true, roles: ["admin"] }), q).toBe(id);
  });
});

describe("the ? key below md goes to the Help on screen", () => {
  const box = (shown: boolean) => ({ getClientRects: () => ({ length: shown ? 1 : 0 }) });
  // the bar's Help: inside `hidden md:contents`, so no boxes below md
  const bar = (shown: boolean) => ({ ...box(shown), closest: () => null });
  // the phone menu's Help row: inside a closed <details> (no boxes), whose Menu button is on screen below md only
  const menuRow = (menuButtonShown: boolean) => ({ ...box(false), closest: (s: string) => (s === "details" ? { querySelector: () => box(menuButtonShown) } : null) });

  it("below md the menu's Help row takes the key and the hidden bar's Help does not; from md up, the other way round", () => {
    // phone: bar hidden, Menu button shown
    expect(ownsHelpKey("public", bar(false))).toBe(false);
    expect(ownsHelpKey("menu", menuRow(true))).toBe(true);
    // desktop: bar shown, Menu button hidden (md:hidden)
    expect(ownsHelpKey("public", bar(true))).toBe(true);
    expect(ownsHelpKey("menu", menuRow(false))).toBe(false);
    // the work side's single Help, and no trigger yet
    expect(ownsHelpKey("work", bar(true))).toBe(true);
    expect(ownsHelpKey("public", null)).toBe(false);
  });

  it("the panel asks ownsHelpKey before opening, and the phone menu's Help listens for the key", () => {
    const panel = fs.readFileSync(path.join(process.cwd(), "src/components/help/help-panel.tsx"), "utf8");
    expect(panel).toMatch(/if \(!ownsHelpKey\(variant, trigger\.current\)\) return;/);
    const shell = fs.readFileSync(path.join(process.cwd(), "src/components/shell/public-shell.tsx"), "utf8");
    const menuSlot = shell.match(/<HelpSlot[^>]*variant="menu"[^>]*\/>/)?.[0];
    expect(menuSlot).toBeDefined();
    expect(menuSlot).not.toMatch(/questionKey=\{false\}/);
  });
});
