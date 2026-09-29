import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");
const { castBallot, enterVoting } = await import("@/server/dal/voting");
const { addListedVoters, getCommunityResults, makeVotingLink, saveVotingSettings, voidVoter } = await import("@/server/dal/voting-organizer");
const { hideComment, postComment } = await import("@/server/dal/comments");
const { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } = await import("@/server/dal/decisions");
const { getPublishedResults, publishResults } = await import("@/server/dal/results");
const { savePrizes } = await import("@/server/dal/organize");
const { computeNormalization } = await import("@/server/dal/normalization");
const { requireEvent } = await import("@/server/dal/events");
const { getPairwiseState, pickPairwise, setJudgingMode, undoPairwise } = await import("@/server/dal/pairwise");
const { moveProjectTrack, projectTrackMoves } = await import("@/server/dal/corrections");
const { issueOwnRecord } = await import("@/server/dal/records");

// Leaving without loss: an event exported from one portal after its whole life (ballots, comments, pairwise answers, a
// merge, the organizers' decisions, published) and imported into another portal as a new event is the same event
// there: its fixtures.json export is the same file, and what the second portal shows from it (the ranking, the
// community count, the other exports) is what the first showed. Before the export carried the event's history, the
// two files still matched (both lost the same things), so the test also checks the file carries each part of it.

const NOW = "2026-09-29T08:00:00.000Z";
let ha: Handle;
let hb: Handle | null = null;

function actorIn(h: Handle, userId: string, isAdmin = false): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin, roles, sessionKind: "login" };
}
const idOf = (h: Handle, email: string) => (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
const organizerA = () => actorIn(ha, "usr_organizer", true);
const count = (h: Handle, sql: string, ...args: unknown[]) => (h.sqlite.prepare(sql).get(...args) as { n: number }).n;

function outcome(call: () => unknown): { status: number; code: string; message: string } | "ok" {
  try {
    call();
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
}

function freshPortal(): Handle {
  const h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_b', 'b@example.org', 'Admin B', NULL, 1, ?)").run(NOW);
  return h;
}

/** Imports a file into portal B as its administrator, and hands back the report (or the refusal). */
function importIntoB(file: unknown) {
  hb ??= freshPortal();
  setHandleForTests(hb);
  try {
    return importEventFile(actorIn(hb, "usr_b", true), file);
  } finally {
    setHandleForTests(ha);
  }
}
function inPortal<T>(h: Handle, fn: () => T): T {
  setHandleForTests(h);
  try {
    return fn();
  } finally {
    setHandleForTests(ha);
  }
}
function inB<T>(fn: () => T): T {
  setHandleForTests(hb);
  try {
    return fn();
  } finally {
    setHandleForTests(ha);
  }
}

beforeEach(() => {
  resetRateLimits();
  ha = openDatabase(":memory:");
  runMigrations(ha, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(ha.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(ha.db, "evt_01", NOW);
  setHandleForTests(ha);
});
afterEach(() => {
  setHandleForTests(null);
  ha.sqlite.close();
  hb?.sqlite.close();
  hb = null;
});

const CLIENT = { ip: "10.9.0.1", agent: "Round trip" };

/**
 * The fixture event's whole life on portal A: a prize and the other dates, three ballots (a signed-in account, a
 * listed address, the open link; one set aside with a reason), two comments (one hidden with a reason), a review's
 * private note, two pairwise answers (one taken back), the three decisions the fixture needs (a flat judge left out,
 * a duplicate merged, an under-reviewed project accepted), then publishing, which ends the vote.
 */
function liveTheEvent() {
  const org = organizerA();
  savePrizes(org, "evt_01", [{ name: "Best in show", description: "Chosen by the judges" }, { name: "Crowd favourite" }]);
  ha.sqlite
    .prepare("UPDATE events SET submissions_open_at = '2026-02-01T09:00:00Z', judging_close_at = '2026-03-08T18:00:00Z', settings = json_set(settings, '$.certificatePlaces', 2, '$.maxTeamSize', 5) WHERE id = 'evt_01'")
    .run();
  saveVotingSettings(org, "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["account", "listed", "link"], votesPerVoter: "3", countLink: true });

  const member = actorIn(ha, idOf(ha, "member1_1@example.org")); // team tm_01 (prj_01)
  const accountBallot = castBallot(member, "evt_01", null, { projectIds: ["prj_02", "prj_03"] }, CLIENT);
  const { links } = addListedVoters(org, "evt_01", { emails: "listed.voter@example.org" });
  castBallot(null, "evt_01", links[0]!.path.slice("/vote/".length), { projectIds: ["prj_03", "prj_07"] }, { ip: "10.9.0.2", agent: "Listed" });
  const { code } = makeVotingLink(org, "evt_01");
  const linkToken = enterVoting(code, { ip: "10.9.0.3", agent: "Link" }).token;
  const linkBallot = castBallot(null, "evt_01", linkToken, { projectIds: ["prj_02", "prj_24", "prj_09"] }, { ip: "10.9.0.3", agent: "Link" });
  voidVoter(org, "evt_01", { voterId: linkBallot.voterId, reason: "Same browser as another ballot" });
  expect(accountBallot.picks).toHaveLength(2);

  const first = postComment(member, "prj_02", { body: "Lovely demo, the onboarding is clear." });
  const other = actorIn(ha, idOf(ha, "member2_1@example.org"));
  const second = postComment(other, "prj_03", { body: "Buy followers at spam.example" });
  hideComment(org, second.id, { reason: "Advertising, not about the project" });
  expect(first.id).toBeTruthy();

  const review = ha.sqlite.prepare("SELECT s.id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE a.judge_user_id = 'jdg_01' ORDER BY s.id LIMIT 1").get() as { id: string };
  ha.sqlite.prepare("INSERT INTO score_comments (score_id, feedback, private_note) VALUES (?, '', 'Ask them about the licence') ON CONFLICT(score_id) DO UPDATE SET private_note = excluded.private_note").run(review.id);
  // two pairwise answers by jdg_01 in their track: one standing, one taken back
  ha.sqlite
    .prepare("INSERT INTO comparisons (id, event_id, judge_user_id, track_id, left_project_id, right_project_id, new_project_id, outcome, created_at, voided_at) VALUES ('cmp_rt_1', 'evt_01', 'jdg_01', 'trk_03', 'prj_02', 'prj_03', 'prj_03', 'left', '2026-03-05T10:00:00.000Z', NULL), ('cmp_rt_2', 'evt_01', 'jdg_01', 'trk_03', 'prj_02', 'prj_24', 'prj_24', 'tie', '2026-03-05T10:01:00.000Z', '2026-03-05T10:02:00.000Z')")
    .run();

  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  moveProjectTrack(org, "evt_01", "prj_05", { trackId: "trk_04", reason: "The team entered the wrong track" });
  publishResults(org, "evt_01");
}

const exported = (file: string) => exportFile(organizerA(), "evt_01", file).body;
const exportedB = (file: string) => inB(() => exportFile(actorIn(hb!, "usr_b", true), "evt_01", file).body);
/** scores.csv without its source column: every review on portal B came by the import, whatever it was on A */
const withoutSource = (csv: string) => {
  const rows = csv.trim().split("\n").map((l) => l.split(","));
  const at = rows[0]!.indexOf("source");
  return rows.map((r) => r.filter((_, i) => i !== at).join(",")).join("\n");
};

describe("fixtures.json moves a whole event: export, import as a new event, export again", () => {
  it("known-bad on the old export: the file carries every part of the event's life", () => {
    liveTheEvent();
    const file = JSON.parse(exported("fixtures.json"));
    expect(file.event).toMatchObject({ submissions_open: "2026-02-01T09:00:00Z", judging_close: "2026-03-08T18:00:00Z", voting_open: expect.any(String), voting_close: expect.any(String) });
    expect(file.settings).toMatchObject({ certificate_places: 2, max_team_size: 5, voting: { modes: ["account", "link", "listed"], votes_per_voter: 3, count_link: true } });
    expect(file.settings.voting).not.toHaveProperty("link_hash");
    expect(file.prizes.map((p: { name: string }) => p.name)).toEqual(["Best in show", "Crowd favourite"]);
    expect(file.ballots).toHaveLength(3);
    expect(file.ballots.map((b: { voter: { kind: string } }) => b.voter.kind).sort()).toEqual(["account", "link", "listed"]);
    expect(file.ballots.find((b: { voter: { kind: string } }) => b.voter.kind === "link").set_aside).toEqual({ at: expect.any(String), reason: "Same browser as another ballot" });
    expect(file.comments).toHaveLength(2);
    expect(file.comments.find((c: { hidden?: unknown }) => c.hidden).hidden.reason).toBe("Advertising, not about the project");
    expect(file.comparisons.map((c: { id: string }) => c.id)).toEqual(["cmp_rt_1", "cmp_rt_2"]);
    expect(file.projects.find((p: { id: string }) => p.id === "prj_41").duplicate_of).toBe("prj_07");
    expect(file.decisions.judges).toEqual([expect.objectContaining({ judge: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" })]);
    expect(file.decisions.accepted_under_reviewed).toEqual(["prj_19"]);
    expect(file.decisions.track_moves).toEqual([{ project: "prj_05", from: "trk_02", to: "trk_04", reason: "The team entered the wrong track", at: expect.any(String) }]);
    expect(file.scores.some((s: { private_note?: string }) => s.private_note === "Ask them about the licence")).toBe(true);
    expect(file.published).toMatchObject({ at: expect.any(String), run: { method: "leniency-shrunk-v1" } });
    expect(file.published.scores.length).toBeGreaterThan(30);
  });

  it("imported into a portal that does not have the event, it exports the same file, and the second portal shows the same event", () => {
    liveTheEvent();
    const a = exported("fixtures.json");
    const report = importIntoB(JSON.parse(a));
    expect(report.renamed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.inserted).toMatchObject({ prizes: 2, voters: 3, votes: 7, comments: 2, comparisons: 2, judgeOverrides: 1, normalizationRuns: 1 });

    // the same file back
    expect(JSON.parse(exportedB("fixtures.json"))).toEqual(JSON.parse(a));
    expect(exportedB("fixtures.json")).toBe(a);
    // and the same event: the published ranking file, the pairwise answers, the projects, the reviews
    for (const f of ["normalized.csv", "comparisons.csv", "projects.csv"]) expect(exportedB(f), f).toBe(exported(f));
    expect(withoutSource(exportedB("scores.csv"))).toBe(withoutSource(exported("scores.csv")));

    // what the pages show: the published results, the community count, the ranking worked out again from the data
    // (all but the audit seal: it names the publishing entry of this portal's log, and on B the publication is part
    // of the import's entry, so B's results page shows no seal; DATA-MODEL.md says so)
    const shown = (r: ReturnType<typeof getPublishedResults>) => ({ ...r, anchor: undefined });
    expect(shown(inB(() => getPublishedResults("evt_01")))).toEqual(shown(getPublishedResults("evt_01")));
    expect(inB(() => getCommunityResults("evt_01"))).toEqual(getCommunityResults("evt_01"));
    const live = (h: Handle) => computeNormalization(h.db, requireEvent(h.db, "evt_01")).projects.map((p) => [p.id, p.score, p.rankNormalized, p.duplicateOf]);
    // the track move is read from the import's own audit row on B, as from the move's row on A
    const moves = (h: Handle) => inPortal(h, () => projectTrackMoves(h.db, "evt_01"));
    expect(moves(hb!)).toEqual(moves(ha));
    expect(moves(hb!)).toHaveLength(1);
    expect(live(hb!)).toEqual(live(ha));
    const b = hb!.sqlite;
    expect(b.prepare("SELECT results_published_at AS at, submissions_open_at AS o, judging_close_at AS j FROM events WHERE id = 'evt_01'").get()).toEqual(
      ha.sqlite.prepare("SELECT results_published_at AS at, submissions_open_at AS o, judging_close_at AS j FROM events WHERE id = 'evt_01'").get(),
    );
    // a certificate the new portal signs names the same place (the certificate places moved with the settings)
    const winner = (() => {
      const r = getPublishedResults("evt_01");
      if (!r.published) throw new Error("not published");
      return r.tracks[0]!.rows[0]!.projectId;
    })();
    const memberEmail = (ha.sqlite.prepare("SELECT u.email FROM team_members m JOIN users u ON u.id = m.user_id JOIN projects p ON p.team_id = m.team_id WHERE p.id = ? ORDER BY u.email LIMIT 1").get(winner) as { email: string }).email;
    const certificate = (h: Handle) =>
      inPortal(h, () => {
        const { id } = issueOwnRecord(actorIn(h, idOf(h, memberEmail)), "evt_01", "participant");
        const row = h.sqlite.prepare("SELECT envelope FROM signed_records WHERE id = ?").get(id) as { envelope: string };
        return (JSON.parse(row.envelope) as { record: { project: unknown; person: unknown } }).record;
      });
    const onA = certificate(ha);
    const onB = certificate(hb!);
    expect(onB.project).toEqual(onA.project);
    expect(onB.person).toEqual(onA.person);
    expect(JSON.stringify(onB.project)).toContain("place");
    // a hidden comment is still hidden, with its reason; the set-aside ballot is still set aside
    expect(b.prepare("SELECT hidden_reason AS r FROM comments WHERE hidden_at IS NOT NULL").all()).toEqual([{ r: "Advertising, not about the project" }]);
    expect(b.prepare("SELECT void_reason AS r FROM voters WHERE voided_at IS NOT NULL").all()).toEqual([{ r: "Same browser as another ballot" }]);
    // no voting link of portal A opens a ballot on B: listed and link voters hold new secrets nobody has
    const hashes = (h: Handle) => (h.sqlite.prepare("SELECT token_hash AS t FROM voters WHERE token_hash IS NOT NULL ORDER BY id").all() as { t: string }[]).map((r) => r.t);
    expect(hashes(hb!).some((t) => hashes(ha).includes(t))).toBe(false);

    // one audit row for the import, naming every restored row by its id (a ballot by its voter and how many picks)
    const row = hb!.db.select().from(auditLog).where(eq(auditLog.action, "fixtures.import")).get()!;
    const restored = (row.after as { restored: Record<string, unknown> }).restored;
    expect(restored).toMatchObject({
      comparisons: ["cmp_rt_1", "cmp_rt_2"],
      merges: [{ duplicate: "prj_41", into: "prj_07" }],
      published: { run: expect.any(String), at: expect.any(String) },
    });
    expect((restored.ballots as { picks: number }[]).map((x) => x.picks).sort()).toEqual([2, 2, 3]);
    // picks are never listed in the log: a ballot is named by its voter and how many picks it has
    expect((restored.ballots as object[]).every((x) => Object.keys(x).sort().join() === "picks,voter")).toBe(true);
  });

  it("a pairwise event moves too: its answers (one taken back), its rulings and its Bradley-Terry ranking as published", () => {
    const org = organizerA();
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    // the judge with the most projects in one track, so the track asks several questions
    const busiest = ha.sqlite
      .prepare("SELECT a.judge_user_id AS j FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.event_id = 'evt_01' AND a.judge_user_id <> 'jdg_07' GROUP BY a.judge_user_id, p.track_id ORDER BY count(*) DESC, a.judge_user_id LIMIT 1")
      .get() as { j: string };
    const judge = actorIn(ha, busiest.j);
    const question = () => {
      const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
      return { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id };
    };
    const first = question();
    pickPairwise(judge, "evt_01", { ...first, outcome: "left" });
    pickPairwise(judge, "evt_01", { ...question(), outcome: "tie" });
    undoPairwise(judge, "evt_01", { trackId: first.trackId });
    pickPairwise(judge, "evt_01", { ...question(), outcome: "right" });
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "only one judge compared it" });
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "flat scores" });
    if (outcome(() => publishResults(org, "evt_01")) !== "ok") publishResults(org, "evt_01", { reason: "published as it stands" });
    const a = exported("fixtures.json");
    const file = JSON.parse(a);
    expect(file.settings.judging_mode).toBe("pairwise");
    expect(file.published.run.method).toBe("bradley-terry-v1");
    expect(file.comparisons.length).toBe(3);
    expect(file.comparisons.filter((c: { taken_back_at?: string }) => c.taken_back_at)).toHaveLength(1);

    importIntoB(file);
    expect(exportedB("fixtures.json")).toBe(a);
    for (const f of ["normalized.csv", "comparisons.csv"]) expect(exportedB(f), f).toBe(exported(f));
    const shown = (r: ReturnType<typeof getPublishedResults>) => ({ ...r, anchor: undefined });
    expect(shown(inB(() => getPublishedResults("evt_01")))).toEqual(shown(getPublishedResults("evt_01")));
  });

  it("a pairwise answer moves with its own track when one of its projects later moved to another track", () => {
    const org = organizerA();
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judge = actorIn(ha, "jdg_15");
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    const q = { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id };
    expect({ trackId: q.trackId, pair: [q.left, q.right].sort() }).toEqual({ trackId: "trk_08", pair: ["prj_20", "prj_27"] });
    pickPairwise(judge, "evt_01", { ...q, outcome: "left" });
    moveProjectTrack(org, "evt_01", "prj_27", { trackId: "trk_01", reason: "The team entered the wrong track" });
    const a = exported("fixtures.json");
    const file = JSON.parse(a);
    expect(file.comparisons).toEqual([expect.objectContaining({ judge: "jdg_15", track: "trk_08" })]);
    expect(file.decisions.track_moves).toEqual([expect.objectContaining({ project: "prj_27", from: "trk_08", to: "trk_01" })]);

    const report = importIntoB(file);
    expect(report.skipped.filter((s) => s.kind === "comparison")).toEqual([]);
    expect(count(hb!, "SELECT count(*) AS n FROM comparisons WHERE track_id = 'trk_08'")).toBe(1);
    expect(exportedB("comparisons.csv")).toBe(exported("comparisons.csv"));
    expect(exportedB("fixtures.json")).toBe(a);
  });

  it("known-bad: an answer in a track neither the file's projects nor its track moves put the pair in stays behind", () => {
    const org = organizerA();
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judge = actorIn(ha, "jdg_15");
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, outcome: "left" });
    moveProjectTrack(org, "evt_01", "prj_27", { trackId: "trk_01", reason: "The team entered the wrong track" });
    const file = JSON.parse(exported("fixtures.json"));
    const planted = { ...file, comparisons: file.comparisons.map((c: object) => ({ ...c, track: "trk_02" })) };
    const report = importIntoB(planted);
    expect(report.skipped).toContainEqual(expect.objectContaining({ kind: "comparison", reason: expect.stringContaining("both projects must be in track trk_02") }));
    expect(count(hb!, "SELECT count(*) AS n FROM comparisons")).toBe(0);
  });

  it("while voting is open the ballots stay behind (sealed, as audit.csv seals them): the file says how many, and the import says so", () => {
    const org = organizerA();
    saveVotingSettings(org, "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["account", "listed"], votesPerVoter: "3" });
    castBallot(actorIn(ha, idOf(ha, "member1_1@example.org")), "evt_01", null, { projectIds: ["prj_02"] }, CLIENT);
    addListedVoters(org, "evt_01", { emails: "waiting@example.org" });
    const file = JSON.parse(exported("fixtures.json"));
    expect(file.ballots_sealed).toBe(1);
    // only the voter list moves: the listed address, with no picks and nothing that says whether they voted
    expect(file.ballots).toEqual([expect.objectContaining({ voter: { kind: "listed", email: "waiting@example.org" }, picks: [] })]);
    expect(JSON.stringify(file.ballots)).not.toContain("last_voted_at");
    const report = importIntoB(file);
    expect(report.skipped).toContainEqual(expect.objectContaining({ kind: "ballots", reason: expect.stringContaining("1 ballot was sealed") }));
    expect(count(hb!, "SELECT count(*) AS n FROM votes")).toBe(0);
  });

});

describe("an event that is here already: its history is its own", () => {
  const addTo = (file: Record<string, unknown>, key: string, row: unknown) => ({ ...file, [key]: [...((file[key] as unknown[]) ?? []), row] });

  it("positive control: its own export imported again changes nothing (every ballot, comment, answer, decision and the ranking are present)", () => {
    liveTheEvent();
    const report = importEventFile(organizerA(), JSON.parse(exported("fixtures.json")));
    expect(Object.values(report.inserted).every((n) => n === 0)).toBe(true);
    expect(report.existing).toMatchObject({ voters: 3, comments: 2, comparisons: 2, judgeOverrides: 1, normalizationRuns: 1 });
    expect(report.skipped).toEqual([]);
  });

  it("known-bad: a file that would add a ballot, a comment, a pairwise answer, a decision, a merge or a published ranking is refused whole (409 new_event_only), naming it", () => {
    liveTheEvent();
    const file = JSON.parse(exported("fixtures.json"));
    const votesBefore = count(ha, "SELECT count(*) AS n FROM votes");
    const cases: [string, Record<string, unknown>, string][] = [
      ["ballot", addTo(file, "ballots", { id: "vtr_forged", voter: { kind: "link" }, order_seed: 1, created_at: NOW, last_voted_at: NOW, picks: [{ project: "prj_05", at: NOW }] }), "1 ballot"],
      ["comment", addTo(file, "comments", { id: "cmt_forged", project: "prj_05", author: "member1_1@example.org", body: "Planted", at: NOW }), "1 comment"],
      ["pairwise answer", addTo(file, "comparisons", { id: "cmp_forged", judge: "jdg_01", track: "trk_03", left: "prj_03", right: "prj_24", new: "prj_24", answer: "right", at: NOW }), "1 pairwise answer"],
      ["decision", { ...file, decisions: { ...file.decisions, judges: [...file.decisions.judges, { id: "ovr_forged", judge: "jdg_02", mode: "exclude", reason: "Planted by a file", at: NOW }] } }, "1 decision"],
      ["accepted project", { ...file, decisions: { ...file.decisions, accepted_under_reviewed: ["prj_19", "prj_05"] } }, "1 decision"],
      ["track move", { ...file, decisions: { ...file.decisions, track_moves: [...file.decisions.track_moves, { project: "prj_06", from: "trk_01", to: "trk_02", reason: "Planted by a file", at: NOW }] } }, "1 decision"],
      ["merge", { ...file, projects: file.projects.map((p: { id: string }) => (p.id === "prj_24" ? { ...p, duplicate_of: "prj_02" } : p)) }, "1 duplicate merge"],
      ["another ranking", { ...file, published: { ...file.published, run: { ...file.published.run, id: "nrm_forged" } } }, "a published ranking"],
    ];
    for (const [what, changed, named] of cases) {
      const refused = outcome(() => importEventFile(organizerA(), changed));
      expect(refused, what).toMatchObject({ status: 409, code: "new_event_only", message: expect.stringContaining(named) });
    }
    expect(count(ha, "SELECT count(*) AS n FROM votes")).toBe(votesBefore);
    expect(count(ha, "SELECT count(*) AS n FROM comments WHERE id = 'cmt_forged'")).toBe(0);
    expect(count(ha, "SELECT count(*) AS n FROM projects WHERE duplicate_of IS NOT NULL")).toBe(1);
  });

  it("known-bad before publishing too: a published ranking in a file never publishes an event that is here", () => {
    const file = JSON.parse(exported("fixtures.json"));
    const planted = { ...file, published: { at: NOW, run: { id: "nrm_planted", method: "leniency-shrunk-v1", computed_at: NOW, params: {} }, scores: [{ project: "prj_01", n: 3, raw_mean: 5, normalized_mean: 5, se: 0, rank_raw: 1, rank_normalized: 1 }] } };
    expect(outcome(() => importEventFile(organizerA(), planted))).toMatchObject({ status: 409, code: "new_event_only", message: expect.stringContaining("a published ranking") });
    expect(ha.sqlite.prepare("SELECT results_published_at AS at FROM events WHERE id = 'evt_01'").get()).toEqual({ at: null });
    // positive control: the same file without it goes in, adding nothing
    expect(outcome(() => importEventFile(organizerA(), file))).toBe("ok");
  });

  it("known-bad: a file whose dates the database would refuse, or whose vote outlives its publication, is a 422 naming the date, not a 500", () => {
    const file = JSON.parse(exported("fixtures.json"));
    const fresh = { ...file, event: { ...file.event, id: "evt_dates", name: "Dates" } };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...fresh, event: { ...fresh.event, submissions_open: "2026-03-02T00:00:00Z" } }, "submissions_open"],
      [{ ...fresh, event: { ...fresh.event, voting_open: "2026-05-02T00:00:00Z", voting_close: "2026-05-01T00:00:00Z" } }, "voting_open"],
      [
        {
          ...fresh,
          event: { ...fresh.event, voting_open: "2026-04-01T00:00:00Z", voting_close: "2026-06-01T00:00:00Z" },
          published: { at: "2026-05-01T00:00:00Z", run: { id: "nrm_d", method: "leniency-shrunk-v1", computed_at: "2026-05-01T00:00:00Z", params: {} }, scores: [] },
        },
        "voting_close",
      ],
    ];
    for (const [changed, field] of cases) {
      expect(outcome(() => importIntoB(changed)), field).toMatchObject({ status: 422, message: expect.stringContaining(`event.${field}`) });
    }
    expect(count(hb!, "SELECT count(*) AS n FROM events")).toBe(0);
    // positive control: the same event with its dates in order goes in
    expect(outcome(() => importIntoB({ ...fresh, event: { ...fresh.event, submissions_open: "2026-02-01T00:00:00Z", voting_open: "2026-04-01T00:00:00Z", voting_close: "2026-05-01T00:00:00Z" } }))).toBe("ok");
  });

  it("its own dates, settings and prizes stand: a file that differs changes none of them and says so in skipped lines", () => {
    const file = JSON.parse(exported("fixtures.json"));
    const changed = { ...file, event: { ...file.event, judging_close: "2026-04-01T00:00:00Z" }, settings: { max_team_size: 9 }, prizes: [{ id: "prz_planted", name: "A prize from a file" }] };
    const report = importEventFile(organizerA(), changed);
    expect(report.skipped.map((s) => s.kind).sort()).toEqual(["event", "prizes", "settings"]);
    expect(ha.sqlite.prepare("SELECT judging_close_at AS j, json_extract(settings, '$.maxTeamSize') AS m FROM events WHERE id = 'evt_01'").get()).toEqual({ j: null, m: null });
    expect(count(ha, "SELECT count(*) AS n FROM prizes WHERE event_id = 'evt_01'")).toBe(0);
  });
});

describe("a new event's history reaches only its own rows", () => {
  /** Portal B already runs an event with a project, a track and a voter whose ids the file also uses. */
  function portalWithAnotherEvent() {
    hb = freshPortal();
    const b = hb.sqlite;
    b.prepare("INSERT INTO events (id, slug, name, submissions_close_at, created_at) VALUES ('evt_theirs', 'theirs', 'Theirs', ?, ?)").run(NOW, NOW);
    b.prepare("INSERT INTO tracks (id, event_id, name, position) VALUES ('trk_03', 'evt_theirs', 'Their track', 0)").run();
    b.prepare("INSERT INTO teams (id, event_id, name, invite_code, created_at) VALUES ('tm_x', 'evt_theirs', 'Their team', 'code-theirs', ?)").run(NOW);
    b.prepare("INSERT INTO projects (id, event_id, team_id, track_id, title, status, submitted_at, created_at, updated_at) VALUES ('prj_02', 'evt_theirs', 'tm_x', 'trk_03', 'Their project', 'submitted', ?, ?, ?)").run(NOW, NOW, NOW);
    b.prepare("INSERT INTO projects (id, event_id, team_id, track_id, title, status, submitted_at, created_at, updated_at) VALUES ('prj_theirs', 'evt_theirs', 'tm_x', 'trk_03', 'Only theirs', 'submitted', ?, ?, ?)").run(NOW, NOW, NOW);
    // and a pairwise answer whose id the file's first answer has too
    b.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_their_judge', 'their.judge@example.org', 'Their judge', NULL, 0, ?)").run(NOW);
    b.prepare("INSERT INTO comparisons (id, event_id, judge_user_id, track_id, left_project_id, right_project_id, new_project_id, outcome, created_at) VALUES ('cmp_rt_1', 'evt_theirs', 'usr_their_judge', 'trk_03', 'prj_02', 'prj_theirs', 'prj_theirs', 'left', ?)").run(NOW);
  }
  const theirVotes = () => count(hb!, "SELECT count(*) AS n FROM votes v JOIN projects p ON p.id = v.project_id WHERE p.event_id = 'evt_theirs'");
  const theirComments = () => count(hb!, "SELECT count(*) AS n FROM comments WHERE project_id IN ('prj_02', 'prj_theirs')");

  it("ids another event holds are renamed, and the ballots, comments and answers follow the renamed rows, never the other event's", () => {
    liveTheEvent();
    portalWithAnotherEvent();
    const report = importIntoB(JSON.parse(exported("fixtures.json")));
    expect(report.renamed).toContainEqual({ kind: "project", from: "prj_02", to: "prj_02.evt_01" });
    expect(report.renamed).toContainEqual({ kind: "comparison", from: "cmp_rt_1", to: "cmp_rt_1.evt_01" });
    expect(hb!.sqlite.prepare("SELECT event_id AS e, judge_user_id AS j FROM comparisons WHERE id = 'cmp_rt_1'").get()).toEqual({ e: "evt_theirs", j: "usr_their_judge" });
    expect(theirVotes()).toBe(0);
    expect(theirComments()).toBe(0);
    const b = hb!.sqlite;
    expect(count(hb!, "SELECT count(*) AS n FROM votes WHERE project_id = 'prj_02.evt_01'")).toBe(2);
    expect(count(hb!, "SELECT count(*) AS n FROM comments WHERE project_id = 'prj_02.evt_01'")).toBe(1);
    expect(b.prepare("SELECT left_project_id AS l, track_id AS t FROM comparisons WHERE id = 'cmp_rt_1.evt_01'").get()).toEqual({ l: "prj_02.evt_01", t: "trk_03.evt_01" });
    // the published run's own record names the renamed projects too (its table and its merges)
    const params = (b.prepare("SELECT params FROM normalization_runs WHERE event_id = 'evt_01'").get() as { params: string }).params;
    expect(params).toContain('"prj_02.evt_01"');
    expect(params).not.toContain('"prj_02"');
    expect(b.prepare("SELECT count(*) AS n FROM normalized_scores ns JOIN projects p ON p.id = ns.project_id WHERE p.event_id <> 'evt_01' AND ns.run_id IN (SELECT id FROM normalization_runs WHERE event_id = 'evt_01')").get()).toEqual({ n: 0 });
    // the same file again finds every renamed row present: nothing is added, nothing refused
    const again = importIntoB(JSON.parse(exported("fixtures.json")));
    expect(Object.values(again.inserted).every((n) => n === 0)).toBe(true);
    expect(again.existing).toMatchObject({ voters: 3, comments: 2, comparisons: 2, judgeOverrides: 1, normalizationRuns: 1 });
  });

  it("known-bad: a file that names another event's project in a pick, a comment, an answer, a merge or its ranking gets none of them there", () => {
    portalWithAnotherEvent();
    const file = JSON.parse(exported("fixtures.json"));
    const planted = {
      ...file,
      event: { ...file.event, id: "evt_new", name: "New event" },
      projects: file.projects.map((p: { id: string }) => (p.id === "prj_05" ? { ...p, duplicate_of: "prj_theirs" } : p)),
      ballots: [{ id: "vtr_p", voter: { kind: "listed", email: "p@example.org" }, order_seed: 7, created_at: NOW, last_voted_at: NOW, picks: [{ project: "prj_theirs", at: NOW }, { project: "prj_05", at: NOW }] }],
      comments: [{ id: "cmt_p", project: "prj_theirs", author: "p@example.org", body: "Planted", at: NOW }],
      comparisons: [{ id: "cmp_p", judge: "jdg_01", track: "trk_03", left: "prj_theirs", right: "prj_03", new: "prj_03", answer: "left", at: NOW }],
      published: { at: NOW, run: { id: "nrm_p", method: "leniency-shrunk-v1", computed_at: NOW, params: {} }, scores: [{ project: "prj_theirs", n: 9, raw_mean: 5, normalized_mean: 5, se: 0, rank_raw: 1, rank_normalized: 1 }] },
    };
    const report = importIntoB(planted);
    expect(report.skipped.map((s) => `${s.kind}:${s.id}`)).toEqual(expect.arrayContaining(["merge:prj_05", "pick:vtr_p:prj_theirs", "comment:cmt_p", "comparison:cmp_p", "published:prj_theirs"]));
    expect(theirVotes()).toBe(0);
    expect(theirComments()).toBe(0);
    expect(count(hb!, "SELECT count(*) AS n FROM comparisons WHERE event_id <> 'evt_theirs' AND (left_project_id = 'prj_theirs' OR right_project_id = 'prj_theirs')")).toBe(0);
    expect(count(hb!, "SELECT count(*) AS n FROM normalized_scores WHERE project_id = 'prj_theirs'")).toBe(0);
    expect(count(hb!, "SELECT count(*) AS n FROM projects WHERE duplicate_of IS NOT NULL")).toBe(0);
    // positive control: the pick for its own project is there
    expect(count(hb!, "SELECT count(*) AS n FROM votes WHERE project_id = 'prj_05'")).toBe(1);
  });
});
