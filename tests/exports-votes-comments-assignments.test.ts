import { beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, count, NOW, organizer, actorById, sqlAll, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// "CSV at every stage" had holes (judge's-eye reading 10, criterion 1): no export of the votes, the comments or the
// assignments. Now votes.csv (per ballot, the picks sealed until voting closes exactly as audit.csv seals them),
// comments.csv (a hidden comment by its reason, never its words) and assignments.csv (judge, project, status, when),
// through the one export route: organizers only, 401 without a session, 403 audited for anyone else.

let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const h = withFixtureEvent();
const { exportFile, EXPORT_FILES } = await import("@/server/dal/exports");
const { auditCsv } = await import("@/server/dal/audit-log");
const { castBallot, enterVoting } = await import("@/server/dal/voting");
const { makeVotingLink, saveVotingSettings, voidVoter } = await import("@/server/dal/voting-organizer");
const { hideComment, postComment } = await import("@/server/dal/comments");
const { recuseAssignment } = await import("@/server/dal/reviews");
const { createLoginSession } = await import("@/server/session");
const { resetRateLimits } = await import("@/server/rate-limit");
const { GET } = await import("@/app/api/events/[event]/export/[file]/route");

beforeEach(() => resetRateLimits());

const NEW = ["votes.csv", "comments.csv", "assignments.csv"] as const;
const csv = (file: string) => exportFile(organizer(), "evt_01", file).body;
/** A CSV as rows of fields (RFC 4180: quoted fields may hold commas, quotes doubled, CRLF lines). */
function parse(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n") {
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else if (c !== "\r") f += c;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((k, i) => [k, r[i] ?? ""])));
}
const ballotProjects = () => (sqlAll<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL ORDER BY id")).map((r) => r.id);
let ipSeq = 0;
const openVoting = () =>
  saveVotingSettings(organizer(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3", countLink: true });
function vote(picks: string[]): string {
  const { code } = makeVotingLink(organizer(), "evt_01");
  const { token } = enterVoting(code, { ip: `10.88.0.${++ipSeq}`, agent: "Agent" });
  castBallot(null, "evt_01", token, { projectIds: picks }, { ip: `10.88.0.${ipSeq}`, agent: "Agent" });
  return (h().sqlite.prepare("SELECT id FROM voters ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
}
const closeVoting = () => sqlRun("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'");

describe("who may export them", () => {
  const get = (file: string) =>
    GET(new Request(`http://localhost:8080/api/events/evt_01/export/${file}`), { params: Promise.resolve({ event: "evt_01", file }) });

  it("each is listed with the other exports", () => {
    for (const f of NEW) expect(EXPORT_FILES).toContain(f);
  });

  it("the organizer gets each, a header row even with nothing to list", async () => {
    for (const f of NEW) {
      cookie = createLoginSession(h().db, "usr_organizer").token;
      const res = await get(f);
      expect(res.status, f).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect((await res.text()).split("\r\n")[0]).toMatch(/^[a-z_]+(,[a-z_]+)+$/);
    }
    // nothing yet: votes and comments are a header row only
    expect(csv("votes.csv").split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(csv("comments.csv").split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("no session is 401; a judge or a participant is 403, and each refusal is an audit row", async () => {
    for (const f of NEW) {
      cookie = undefined;
      expect((await get(f)).status, f).toBe(401);
      const before = count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'");
      cookie = createLoginSession(h().db, "jdg_24").token;
      expect((await get(f)).status, `${f} as a judge`).toBe(403);
      expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'")).toBe(before + 1);
      const member = sqlAll<{ user_id: string }>("SELECT user_id FROM team_members LIMIT 1")[0]!.user_id;
      cookie = createLoginSession(h().db, member).token;
      expect((await get(f)).status, `${f} as a participant`).toBe(403);
    }
    cookie = undefined;
  });
});

describe("votes.csv", () => {
  it("one row per ballot; while voting is open the picks are sealed, for every ballot, as audit.csv seals them", () => {
    openVoting();
    const [a, b, c] = ballotProjects();
    const v1 = vote([a!, b!]);
    const v2 = vote([c!]);
    const text = csv("votes.csv");
    const rows = parse(text);
    expect(rows.map((r) => r.voter_id)).toEqual([v1, v2]);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "link", counts: "yes", picks: "hidden until voting closes", pick_titles: "hidden until voting closes" });
      expect(r.last_voted_at).not.toBe("");
    }
    // nothing of the picks anywhere in the file: not an id, not a title
    const titles = sqlAll<{ id: string; title: string }>("SELECT id, title FROM projects WHERE id IN (?, ?, ?)", a, b, c);
    for (const p of titles) {
      expect(text).not.toContain(p.id);
      expect(text).not.toContain(p.title);
    }
    // the same rule seals audit.csv's ballot rows at the same moment
    expect(auditCsv(h().db, "evt_01")).toContain("hidden until voting closes");
  });

  it("once voting closes the picks show, a set-aside ballot says so with its reason", () => {
    openVoting();
    const [a, b, c] = ballotProjects();
    const v1 = vote([a!, b!]);
    const v2 = vote([c!]);
    voidVoter(organizer(), "evt_01", { voterId: v2, reason: "two ballots from one browser" });
    closeVoting();
    const rows = parse(csv("votes.csv"));
    const one = rows.find((r) => r.voter_id === v1)!;
    expect(one.picks.split("; ").sort()).toEqual([a, b].sort());
    expect(one.counts).toBe("yes");
    const two = rows.find((r) => r.voter_id === v2)!;
    expect(two).toMatchObject({ picks: c, counts: "set aside", set_aside_reason: "two ballots from one browser" });
    expect(two.set_aside_at).not.toBe("");
    // positive control for the seal: audit.csv opens at the same moment
    expect(auditCsv(h().db, "evt_01")).not.toContain("hidden until voting closes");
  });

  it("before voting ever opens the picks are sealed too (the rule is 'until the window has closed')", () => {
    openVoting();
    vote([ballotProjects()[0]!]);
    sqlRun("UPDATE events SET voting_open_at = '2999-01-01T00:00:00.000Z', voting_close_at = '2999-02-01T00:00:00.000Z' WHERE id = 'evt_01'");
    expect(parse(csv("votes.csv"))[0]!.picks).toBe("hidden until voting closes");
  });
});

describe("comments.csv", () => {
  it("every comment with its author; a hidden one keeps its row and reason, never its words", () => {
    const [p1, p2] = ballotProjects();
    const shown = postComment(organizer(), p1!, { body: "Lovely demo, the map is clear" });
    const hidden = postComment(organizer(), p2!, { body: "call me on 555-0199 SECRETWORDS" });
    hideComment(organizer(), hidden.id, { reason: "a phone number" });
    const text = csv("comments.csv");
    expect(text).not.toContain("SECRETWORDS");
    expect(text).not.toContain("555-0199");
    const rows = parse(text);
    expect(rows.find((r) => r.comment_id === shown.id)).toMatchObject({ project_id: p1, status: "shown", body: "Lovely demo, the map is clear", author: "Demo Organizer" });
    expect(rows.find((r) => r.comment_id === hidden.id)).toMatchObject({ project_id: p2, status: "hidden", body: "", hidden_reason: "a phone number", hidden_by: "Demo Organizer" });
  });

  it("a comment that reads as a spreadsheet formula is defused", () => {
    postComment(organizer(), ballotProjects()[0]!, { body: '=HYPERLINK("http://evil.example","x")' });
    const line = csv("comments.csv").split("\r\n")[1]!;
    expect(line).toContain(`"'=HYPERLINK(`);
  });
});

describe("assignments.csv", () => {
  it("one row per assignment: judge, project, status, how far the review got and when", () => {
    const rows = parse(csv("assignments.csv"));
    expect(rows).toHaveLength(count("SELECT count(*) AS n FROM assignments WHERE event_id = 'evt_01'"));
    const done = rows.find((r) => r.judge_id === "jdg_24")!;
    expect(done).toMatchObject({ status: "done", review: "submitted", run: "import" });
    expect(done.submitted_at).not.toBe("");
    expect(done.assigned_at).not.toBe("");
  });

  it("an open review with nothing saved, a draft, and a recusal with its reason", () => {
    addUser("usr_j", "j@example.org", "Jo Judge");
    sqlRun("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES ('usr_j', 'evt_01', 'judge', ?)", NOW);
    sqlRun("INSERT INTO judge_tracks (judge_user_id, event_id, track_id) VALUES ('usr_j', 'evt_01', 'trk_04')");
    sqlRun("INSERT INTO assignment_runs (id, event_id, mode, seed, params, created_at) VALUES ('run_t', 'evt_01', 'topup', 1, '{}', ?)", NOW);
    const [p1, p2, p3] = sqlAll<{ id: string }>("SELECT id FROM projects WHERE track_id = 'trk_04' ORDER BY id LIMIT 3");
    for (const [i, p] of [p1, p2, p3].entries()) {
      sqlRun("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, status, created_at) VALUES (?, 'evt_01', 'usr_j', ?, 'run_t', 'pending', ?)", `asg_j${i}`, p!.id, NOW);
    }
    sqlRun("INSERT INTO scores (id, assignment_id, submitted_at, updated_at) VALUES ('scr_j', 'asg_j1', NULL, ?)", NOW);
    recuseAssignment(actorById("usr_j"), "asg_j2", { reason: "my cousin's team" });
    const rows = parse(csv("assignments.csv"));
    const of = (id: string) => rows.find((r) => r.assignment_id === id)!;
    expect(of("asg_j0")).toMatchObject({ judge: "Jo Judge", status: "pending", review: "none", last_saved_at: "", run: "top-up" });
    expect(of("asg_j1")).toMatchObject({ status: "pending", review: "draft", last_saved_at: NOW, submitted_at: "" });
    expect(of("asg_j2")).toMatchObject({ status: "recused", recuse_reason: "my cousin's team" });
    expect(of("asg_j2").recused_at).not.toBe("");
    // the recusal is the audited action; the export only reads it
    expect(auditRows().some((r) => r.action === "review.recuse" && r.targetId === "asg_j2")).toBe(true);
  });
});
