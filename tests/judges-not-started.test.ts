import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { addUser, NOW, organizer, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The organizer's Judges page had no "not started" view (judge's-eye reading 10, criterion 1): the judges who have
// reviews assigned and have saved nothing, easy to find and to remind. The Judges data (and GET .../judges) marks
// them notStarted; the page lists them after the flagged ones and has a view of only them, with their reminders.

let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/organize/sample-hack-2026/judges",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {} }),
}));

const h = withFixtureEvent();
const { getJudges } = await import("@/server/dal/judges");
const { createLoginSession } = await import("@/server/session");
const { GET } = await import("@/app/api/events/[event]/judges/route");
const JudgesPage = (await import("@/app/organize/[event]/judges/page")).default;

/** A new judge of the Security track (trk_04) with an open review of each of its first `n` projects. */
function newJudge(id: string, name: string, n: number): string[] {
  addUser(id, `${id}@example.org`, name);
  sqlRun("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, 'evt_01', 'judge', ?)", id, NOW);
  sqlRun("INSERT INTO judge_tracks (judge_user_id, event_id, track_id) VALUES (?, 'evt_01', 'trk_04')", id);
  sqlRun("INSERT OR IGNORE INTO assignment_runs (id, event_id, mode, seed, params, created_at) VALUES ('run_t', 'evt_01', 'topup', 1, '{}', ?)", NOW);
  const projects = h()
    .sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND track_id = 'trk_04' ORDER BY id LIMIT ?")
    .all(n) as { id: string }[];
  return projects.map((p, i) => {
    const aid = `asg_${id}_${i}`;
    sqlRun("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, status, created_at) VALUES (?, 'evt_01', ?, ?, 'run_t', 'pending', ?)", aid, id, p.id, NOW);
    return aid;
  });
}
const row = (id: string) => getJudges(organizer(), "evt_01").judges.find((j) => j.id === id)!;

describe("which judges have not started", () => {
  it("reviews assigned and nothing saved: not started", () => {
    newJudge("usr_idle", "Ida Idle", 3);
    expect(row("usr_idle")).toMatchObject({ assigned: 3, started: 0, notStarted: true });
  });

  it("positive controls: every fixture judge has started, and a judge with nothing assigned is not 'not started'", () => {
    for (const j of getJudges(organizer(), "evt_01").judges) expect(j.notStarted, j.id).toBe(false);
    addUser("usr_none", "none@example.org", "Nora None");
    sqlRun("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES ('usr_none', 'evt_01', 'judge', ?)", NOW);
    expect(row("usr_none")).toMatchObject({ assigned: 0, notStarted: false });
  });

  it("a draft (a review row with nothing submitted) counts as started", () => {
    const [a] = newJudge("usr_draft", "Dan Draft", 2);
    expect(row("usr_draft").notStarted).toBe(true);
    sqlRun("INSERT INTO scores (id, assignment_id, submitted_at, updated_at) VALUES ('scr_d', ?, NULL, ?)", a, NOW);
    expect(row("usr_draft")).toMatchObject({ started: 1, done: 0, notStarted: false });
  });

  it("a declared conflict counts as started", () => {
    const [a] = newJudge("usr_rec", "Rita Recused", 2);
    sqlRun("UPDATE assignments SET status = 'recused' WHERE id = ?", a);
    expect(row("usr_rec")).toMatchObject({ recused: 1, notStarted: false });
  });

  it("a standing pairwise answer counts as started; a taken-back one does not", () => {
    newJudge("usr_pair", "Pia Pairwise", 2);
    const [left, right] = h().sqlite.prepare("SELECT project_id AS p FROM assignments WHERE judge_user_id = 'usr_pair' ORDER BY id").all() as { p: string }[];
    sqlRun(
      "INSERT INTO comparisons (id, event_id, judge_user_id, track_id, left_project_id, right_project_id, new_project_id, outcome, created_at, voided_at) VALUES ('cmp_1', 'evt_01', 'usr_pair', 'trk_04', ?, ?, ?, 'left', ?, ?)",
      left!.p,
      right!.p,
      right!.p,
      NOW,
      NOW,
    );
    expect(row("usr_pair").notStarted).toBe(true);
    sqlRun("UPDATE comparisons SET voided_at = NULL WHERE id = 'cmp_1'");
    expect(row("usr_pair").notStarted).toBe(false);
  });

  it("GET /api/events/{event}/judges carries it for the organizer; a judge is refused", async () => {
    newJudge("usr_idle", "Ida Idle", 1);
    const get = () => GET(new Request("http://localhost:8080/api/events/evt_01/judges"), { params: Promise.resolve({ event: "evt_01" }) });
    cookie = createLoginSession(h().db, "usr_organizer").token;
    const ok = await get();
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { judges: { id: string; notStarted: boolean }[] };
    expect(body.judges.find((j) => j.id === "usr_idle")?.notStarted).toBe(true);
    cookie = createLoginSession(h().db, "jdg_01").token;
    expect((await get()).status).toBe(403);
    cookie = undefined;
    expect((await get()).status).toBe(401);
  });
});

describe("the Judges page", () => {
  const draw = async (show?: string) => {
    cookie = createLoginSession(h().db, "usr_organizer").token;
    const page = await JudgesPage({ params: Promise.resolve({ event: "sample-hack-2026" }), searchParams: Promise.resolve(show ? { show } : {}) } as never);
    cookie = undefined;
    // prerender waits for every async part of the tree (the page's shells read the session themselves)
    const { prelude } = await prerender(page);
    return await new Response(prelude).text();
  };

  it("lists the judges who have not started after the flagged ones, and links the view of only them", async () => {
    newJudge("usr_idle", "Ida Idle", 3);
    const html = await draw();
    expect(html).toContain("1 not started");
    expect(html).toMatch(/href="\/organize\/sample-hack-2026\/judges\?show=not-started"[^>]*>Not started(<!-- -->)? <span[^>]*>1<\/span>/);
    const groups = [...html.matchAll(/label-mono [^"]*">([A-Za-z ]+)(?:<!-- -->)? · /g)].map((m) => m[1]);
    expect(groups.slice(0, 2)).toEqual(["Flagged", "Not started"]);
    // in the table (the load figure above it keeps every judge, in the table's order too)
    expect(html.indexOf('font-medium">Ida Idle')).toBeLessThan(html.indexOf('font-medium">Diego Herrera'));
  });

  it("the view of only them lists no one else and offers their reminders and addresses", async () => {
    newJudge("usr_idle", "Ida Idle", 3);
    newJudge("usr_idle2", "Ivo Idle", 1);
    const html = await draw("not-started");
    expect(html).toContain('font-medium">Ida Idle');
    expect(html).toContain('font-medium">Ivo Idle');
    expect(html).not.toContain('font-medium">Diego Herrera'); // not in the table
    expect(html).toContain('title="Diego Herrera: 11 of 11"'); // the load figure still shows everyone
    expect(html).toContain("These 2 judges have reviews assigned and have saved nothing yet");
    expect(html).toContain("Copy 2 reminders");
    expect(html).toContain("Copy addresses");
  });

  it("positive control: with everyone started, no view link, and the view says so", async () => {
    expect(await draw()).toContain("Every judge has started");
    const view = await draw("not-started");
    expect(view).toContain("Every judge with reviews assigned has saved something.");
    expect(view).not.toContain("Copy addresses");
  });
});
