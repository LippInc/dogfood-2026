import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { resetRateLimits } from "@/server/rate-limit";
import { HttpError } from "@/server/errors";
import { castBallot, enterVoting } from "@/server/dal/voting";
import { makeVotingLink, saveVotingSettings } from "@/server/dal/voting-organizer";
import type { Actor } from "@/server/authz";

// A ballot at the exact close: the app decides it by the request's clock (authz.ts decideVote), the votes trigger by
// the database's (src/server/db/triggers.ts votingClosed). When the close falls between the two, the trigger's
// refusal is the answer, and it must be the app's own 403 voting_closed, audited like it, never a 500. The clock
// stub below puts the request's clock a minute before the close while the database's reads past it.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  vi.useRealTimers();
  setHandleForTests(null);
  h.sqlite.close();
});

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const org = () => actorById("usr_organizer");
const onBallot = () =>
  (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL ORDER BY id").all() as { id: string }[]).map((r) => r.id);
const picksOf = (voterId: string) => (h.sqlite.prepare("SELECT project_id AS p FROM votes WHERE voter_id = ? ORDER BY project_id").all(voterId) as { p: string }[]).map((r) => r.p);
const refusedBallots = () =>
  h.sqlite.prepare("SELECT actor_label AS who, target_id AS target, after FROM audit_log WHERE action = 'authz.refused' AND json_extract(after, '$.attempted') = 'vote.cast'").all() as {
    who: string;
    target: string;
    after: string;
  }[];
const client = { ip: "10.88.0.1", agent: "Agent" };

/** A link voter with a first ballot, cast while voting is open by both clocks. */
function voterWithBallot(picks: string[]) {
  saveVotingSettings(org(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["account", "listed", "link"], votesPerVoter: "3", countLink: true });
  const { code } = makeVotingLink(org(), "evt_01");
  const { token } = enterVoting(code, { ip: "10.88.0.2", agent: "Agent" });
  const { voterId } = castBallot(null, "evt_01", token, { projectIds: picks }, client) as { voterId: string };
  return { token, voterId };
}

/** The close set a second ago by the database's clock, and the request's clock a minute before it. */
function closeBetweenTheClocks() {
  const real = Date.now();
  h.sqlite.prepare("UPDATE events SET voting_close_at = ? WHERE id = 'evt_01'").run(new Date(real - 1000).toISOString());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(real - 60_000);
}

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (err) {
    expect(err, String(err)).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("a ballot at the exact close", () => {
  it("positive control: with the request's clock stubbed and the close still ahead by both clocks, the ballot is saved", () => {
    const projects = onBallot();
    const { token, voterId } = voterWithBallot([projects[0]!]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60_000);
    castBallot(null, "evt_01", token, { projectIds: [projects[1]!] }, client);
    expect(picksOf(voterId)).toEqual([projects[1]]);
  });

  it("known-bad: passed by the request's clock, refused by the database's: 403 voting_closed, audited, nothing saved", () => {
    const projects = onBallot();
    const { token, voterId } = voterWithBallot([projects[0]!]);
    const auditRows = (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n;
    closeBetweenTheClocks();
    const err = refusal(() => castBallot(null, "evt_01", token, { projectIds: [projects[1]!, projects[2]!] }, client));
    expect([err.status, err.code]).toEqual([403, "voting_closed"]);
    expect(err.message).toMatch(/^Voting closed at /);
    expect(picksOf(voterId)).toEqual([projects[0]]); // the old picks stay, the new ones never landed
    const refused = refusedBallots();
    expect(refused).toHaveLength(1);
    expect(refused[0]!.target).toBe(voterId);
    expect(JSON.parse(refused[0]!.after)).toEqual({ attempted: "vote.cast", status: 403, code: "voting_closed" });
    // the refusal is the only new row, and the chain still links
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditRows + 1);
  });

  it("an account's first ballot at the close leaves no voter row behind either", () => {
    const projects = onBallot();
    voterWithBallot([projects[0]!]);
    const judge = h.sqlite.prepare("SELECT u.id AS id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'judge' AND r.event_id = 'evt_01' LIMIT 1").get() as { id: string };
    const voters = () => (h.sqlite.prepare("SELECT count(*) AS n FROM voters WHERE user_id = ?").get(judge.id) as { n: number }).n;
    closeBetweenTheClocks();
    const err = refusal(() => castBallot(actorById(judge.id), "evt_01", null, { projectIds: [projects[3]!] }, client));
    expect([err.status, err.code]).toEqual([403, "voting_closed"]);
    expect(voters()).toBe(0);
    expect(refusedBallots().at(-1)!.who).toBe(actorById(judge.id).name);
  });
});
