import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError, RateLimitedError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { sha256 } from "@/server/util";
import {
  castBallot,
  describeVotingCode,
  enterVoting,
  getBallot,
  type Client,
} from "@/server/dal/voting";
import {
  addListedVoters,
  getCommunityResults,
  getVotingAdmin,
  makeVotingLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
} from "@/server/dal/voting-organizer";
import { auditCsv, getAuditLog } from "@/server/dal/audit-log";
import { getOverview } from "@/server/dal/overview";
import { mergeDuplicate, unmergeDuplicate } from "@/server/dal/decisions";
import { createTeam, joinTeam } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the voting DAL goes through getDb()
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

const count = (sql: string, ...args: unknown[]) => (h.sqlite.prepare(sql).get(...args) as { n: number }).n;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const auditCount = (action: string) => auditRows().filter((r) => r.action === action).length;

const userIdByEmail = (email: string) =>
  (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = h.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const org = () => actorById("usr_organizer");
const participant = () => actorById(userIdByEmail("member1_1@example.org"));

const CLIENT: Client = { ip: "10.0.0.5", agent: "VoterBrowser" };

/**
 * The standard open window: all three ways to vote, three picks each. Open-link ballots
 * count here, so these tests can use link voters as plain anonymous voters; the rule that
 * they are counted apart by default is tested in voting-open-link.test.ts.
 */
const openVoting = () =>
  saveVotingSettings(org(), "evt_01", {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
    countLink: true,
  });

let ipSeq = 0;
const nextIp = () => `10.42.0.${++ipSeq}`;

/** A fresh open-link voter: rotates the link, enters from a fresh network address. */
function linkToken(): string {
  const { code } = makeVotingLink(org(), "evt_01");
  return enterVoting(code, { ip: nextIp(), agent: "Agent" }).token;
}

const voterById = (id: string) =>
  h.sqlite.prepare("SELECT * FROM voters WHERE id = ?").get(id) as
    | { id: string; kind: string; user_id: string | null; token_hash: string | null; voided_at: string | null; void_reason: string | null }
    | undefined;

describe("saveVotingSettings", () => {
  it("refuses a participant with 403 and changes nothing", () => {
    expectHttpError(
      () => saveVotingSettings(participant(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3" }),
      403,
      "not_an_organizer",
    );
    expect(h.sqlite.prepare("SELECT voting_open_at AS o, voting_close_at AS c FROM events WHERE id = 'evt_01'").get()).toEqual({ o: null, c: null });
  });

  it("known-bad input: a close before the open, and only one of the two times, are 422", () => {
    expectHttpError(
      () => saveVotingSettings(org(), "evt_01", { votingOpenAt: "2999-02-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3" }),
      422,
      "invalid",
    );
    expectHttpError(
      () => saveVotingSettings(org(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "", modes: ["link"], votesPerVoter: "3" }),
      422,
      "invalid",
    );
    expect(h.sqlite.prepare("SELECT voting_open_at AS o FROM events WHERE id = 'evt_01'").get()).toEqual({ o: null });
  });

  it("takes an API caller's full ISO times like the date picker's, and refuses a day that does not exist (422)", () => {
    saveVotingSettings(org(), "evt_01", { votingOpenAt: "2026-01-01T00:00:00.000Z", votingCloseAt: "2999-01-01T12:30Z", modes: ["link"], votesPerVoter: "3" });
    expect(h.sqlite.prepare("SELECT voting_open_at AS o, voting_close_at AS c FROM events WHERE id = 'evt_01'").get()).toEqual({
      o: "2026-01-01T00:00:00.000Z",
      c: "2999-01-01T12:30:00.000Z",
    });
    expectHttpError(
      () => saveVotingSettings(org(), "evt_01", { votingOpenAt: "2026-02-30T10:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3" }),
      422,
      "invalid",
    );
    expect(h.sqlite.prepare("SELECT voting_open_at AS o FROM events WHERE id = 'evt_01'").get()).toEqual({ o: "2026-01-01T00:00:00.000Z" });
  });

  it("stores a valid window and writes exactly one voting.settings audit row", () => {
    saveVotingSettings(org(), "evt_01", {
      votingOpenAt: "2026-01-01T00:00",
      votingCloseAt: "2999-01-01T00:00",
      modes: ["account", "listed", "link"],
      votesPerVoter: "3",
    });
    expect(h.sqlite.prepare("SELECT voting_open_at AS o, voting_close_at AS c FROM events WHERE id = 'evt_01'").get()).toEqual({
      o: "2026-01-01T00:00:00.000Z",
      c: "2999-01-01T00:00:00.000Z",
    });
    expect(auditCount("voting.settings")).toBe(1);
  });
});

describe("the open voting link", () => {
  beforeEach(() => {
    openVoting();
  });

  it("makes a link; entering it creates a link voter whose token is stored only as its hash, audited once", () => {
    const { code, path } = makeVotingLink(org(), "evt_01");
    expect(path).toBe(`/vote/${code}`);

    const entered = enterVoting(code, { ip: "10.0.0.1", agent: "A" });
    expect(entered.eventId).toBe("evt_01");
    expect(entered.eventSlug).toBe("sample-hack-2026");
    expect(entered.token).toBeTruthy();

    const row = h.sqlite.prepare("SELECT * FROM voters WHERE token_hash = ?").get(sha256(entered.token)) as { kind: string } | undefined;
    expect(row?.kind).toBe("link");

    expect(auditCount("voter.join_link")).toBe(1);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("refuses an unknown code with 404", () => {
    expectHttpError(() => enterVoting("no-such-code", { ip: "10.0.0.2", agent: "A" }), 404, "not_found");
  });
});

describe("castBallot over the open link", () => {
  beforeEach(() => {
    openVoting();
  });

  it("casts sorted picks, keeps one row per pick, audits once; same picks again write nothing; new picks replace the old", () => {
    const token = linkToken();

    const cast = castBallot(null, "evt_01", token, { projectIds: ["prj_03", "prj_01", "prj_02"] }, CLIENT);
    expect(cast.picks).toEqual(["prj_01", "prj_02", "prj_03"]);
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", cast.voterId)).toBe(3);

    const casts = auditRows().filter((r) => r.action === "vote.cast");
    expect(casts).toHaveLength(1);
    expect(casts[0]!.actorUserId).toBeNull();
    expect(casts[0]!.actorLabel.startsWith("Link voter")).toBe(true);
    expect(casts[0]!.targetId).toBe(cast.voterId);
    expect((casts[0]!.after as { picks: string[] }).picks).toEqual(["prj_01", "prj_02", "prj_03"]);

    // same picks, different order in the request: a no-op, not a second ballot
    castBallot(null, "evt_01", token, { projectIds: ["prj_02", "prj_01", "prj_03"] }, CLIENT);
    expect(auditCount("vote.cast")).toBe(1);

    // new picks: the old rows are replaced, not appended
    castBallot(null, "evt_01", token, { projectIds: ["prj_04"] }, CLIENT);
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", cast.voterId)).toBe(1);
    expect(h.sqlite.prepare("SELECT project_id AS p FROM votes WHERE voter_id = ?").get(cast.voterId)).toEqual({ p: "prj_04" });
    expect(auditCount("vote.cast")).toBe(2);
  });

  it("known-bad ballots: too many picks, an unknown project, and neither token nor session", () => {
    const token = linkToken();
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_01", "prj_02", "prj_03", "prj_04"] }, CLIENT), 422, "invalid");
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_99"] }, CLIENT), 422, "invalid");
    expectHttpError(() => castBallot(null, "evt_01", null, { projectIds: ["prj_01"] }, CLIENT), 401, "unauthenticated");
    expect(count("SELECT count(*) AS n FROM votes")).toBe(0);
  });

  it("an account voter gets an account voter row; their ballot order is fixed by who they are, before and after the first vote", () => {
    const p = participant();
    const before = getBallot(p, "evt_01", null);
    expect(before.projects).toHaveLength(41);
    expect(before.picks).toEqual([]);

    const cast = castBallot(p, "evt_01", null, { projectIds: ["prj_05"] }, CLIENT);
    const row = voterById(cast.voterId);
    expect(row?.kind).toBe("account");
    expect(row?.user_id).toBe(p.userId);

    const after = getBallot(p, "evt_01", null);
    expect(after.picks).toEqual(["prj_05"]);
    expect(after.projects.map((x) => x.id)).toEqual(before.projects.map((x) => x.id));
  });

  it("known-bad: a signed-in voter cannot vote for their own team's project (422, nothing saved), by account or by link; the ballot marks it", () => {
    openVoting();
    const p = participant();
    const own = (
      h.sqlite
        .prepare("SELECT p.id AS id FROM projects p JOIN team_members m ON m.team_id = p.team_id WHERE m.user_id = ? AND p.event_id = 'evt_01'")
        .get(p.userId) as { id: string }
    ).id;
    const other = own === "prj_05" ? "prj_06" : "prj_05";
    const votesBefore = count("SELECT count(*) AS n FROM votes");

    expectHttpError(() => castBallot(p, "evt_01", null, { projectIds: [own] }, CLIENT), 422, "invalid");
    expectHttpError(() => castBallot(p, "evt_01", null, { projectIds: [other, own] }, CLIENT), 422, "invalid");
    const token = linkToken();
    expectHttpError(() => castBallot(p, "evt_01", token, { projectIds: [own] }, CLIENT), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM votes")).toBe(votesBefore);

    // positive controls: another project counts; the ballot marks only the own one, and only for them
    castBallot(p, "evt_01", null, { projectIds: [other] }, CLIENT);
    expect(count("SELECT count(*) AS n FROM votes")).toBe(votesBefore + 1);
    const ballot = getBallot(p, "evt_01", null);
    expect(ballot.projects.filter((x) => x.own).map((x) => x.id)).toEqual([own]);
    expect(getBallot(null, "evt_01", null).projects.some((x) => x.own)).toBe(false);
    // the gap JUDGING.md names: signed out, an open link cannot know whose team it is
    expect(castBallot(null, "evt_01", token, { projectIds: [own] }, CLIENT).voterId).toBeTruthy();

    // a voter-list link is a known address: the team member's own link cannot pick their project,
    // an outsider's link can (positive control), and the member's ballot marks it
    const { links } = addListedVoters(org(), "evt_01", { emails: `${p.email}, outsider@example.org` });
    const tokenOf = (email: string) => links.find((l) => l.email === email)!.path.slice("/vote/".length);
    expectHttpError(() => castBallot(null, "evt_01", tokenOf(p.email), { projectIds: [own] }, CLIENT), 422, "invalid");
    expect(castBallot(null, "evt_01", tokenOf("outsider@example.org"), { projectIds: [own] }, CLIENT).voterId).toBeTruthy();
    expect(getBallot(null, "evt_01", tokenOf(p.email)).projects.filter((x) => x.own).map((x) => x.id)).toEqual([own]);
    expect(getBallot(null, "evt_01", tokenOf("outsider@example.org")).projects.some((x) => x.own)).toBe(false);
  });

  it("with account mode off, a participant's ballot is 403 voting_mode_off with one new authz.refused row", () => {
    saveVotingSettings(org(), "evt_01", {
      votingOpenAt: "2026-01-01T00:00",
      votingCloseAt: "2999-01-01T00:00",
      modes: ["link"],
      votesPerVoter: "3",
    });
    const refusalsBefore = auditCount("authz.refused");

    expectHttpError(() => castBallot(participant(), "evt_01", null, { projectIds: ["prj_01"] }, CLIENT), 403, "voting_mode_off");

    const refusals = auditRows().filter((r) => r.action === "authz.refused");
    expect(refusals).toHaveLength(refusalsBefore + 1);
    expect(JSON.stringify(refusals.at(-1)!.after)).toContain('"voting_mode_off"');
  });
});

describe("one ballot per known person", () => {
  const ownOf = (userId: string) =>
    (
      h.sqlite
        .prepare("SELECT p.id AS id FROM projects p JOIN team_members m ON m.team_id = p.team_id WHERE m.user_id = ? AND p.event_id = 'evt_01'")
        .get(userId) as { id: string } | undefined
    )?.id;

  it("known-bad: someone who voted signed in cannot also vote with their personal link, nor the other way round (409 already_voted, nothing saved)", () => {
    openVoting();
    const p = participant();
    const [a, b] = ["prj_05", "prj_06", "prj_07"].filter((id) => id !== ownOf(p.userId));
    const { links } = addListedVoters(org(), "evt_01", { emails: p.email });
    const token = links[0]!.path.slice("/vote/".length);

    castBallot(p, "evt_01", null, { projectIds: [a!] }, CLIENT);
    const votesBefore = count("SELECT count(*) AS n FROM votes");
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: [b!] }, CLIENT), 409, "already_voted");
    expectHttpError(() => castBallot(p, "evt_01", token, { projectIds: [b!] }, CLIENT), 409, "already_voted");
    expect(count("SELECT count(*) AS n FROM votes")).toBe(votesBefore);

    // positive controls: an empty save is harmless; once the account ballot is emptied the link takes the picks,
    // and then the account is the second ballot
    expect(castBallot(null, "evt_01", token, { projectIds: [] }, CLIENT).picks).toEqual([]);
    castBallot(p, "evt_01", null, { projectIds: [] }, CLIENT);
    expect(castBallot(null, "evt_01", token, { projectIds: [b!] }, CLIENT).picks).toEqual([b]);
    expectHttpError(() => castBallot(p, "evt_01", null, { projectIds: [a!] }, CLIENT), 409, "already_voted");
    // someone else's personal link is not affected
    const other = addListedVoters(org(), "evt_01", { emails: "someone-else@example.org" }).links[0]!.path.slice("/vote/".length);
    expect(castBallot(null, "evt_01", other, { projectIds: [a!] }, CLIENT).picks).toEqual([a]);
  });
});

describe("the flags see across ways of voting", () => {
  it("a signed-in ballot and an open-link ballot from the same browser and network are flagged together; another browser is not (positive control)", () => {
    openVoting();
    const p = actorById("usr_organizer");
    castBallot(p, "evt_01", null, { projectIds: ["prj_01"] }, CLIENT);
    const { code } = makeVotingLink(org(), "evt_01");
    const same = enterVoting(code, CLIENT).token;
    castBallot(null, "evt_01", same, { projectIds: ["prj_02"] }, CLIENT);
    const other = linkToken();
    castBallot(null, "evt_01", other, { projectIds: ["prj_03"] }, { ip: "10.9.9.9", agent: "Other" });

    const { suspected } = getVotingAdmin(org(), "evt_01");
    expect(suspected).toHaveLength(1);
    expect(suspected[0]!.voters.map((v) => v.kind).sort()).toEqual(["account", "link"]);
  });
});

describe("the pick limit", () => {
  const limitNow = () => JSON.parse((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_01'").get() as { settings: string }).settings).voting.votesPerVoter;
  const settings = (n: string) => ({ votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["account", "listed", "link"], votesPerVoter: n });

  it("known-bad: once a ballot holds 3 picks the limit cannot drop to 2 (409 ballots_too_large); it can rise, and come back to 3", () => {
    openVoting();
    const p = participant();
    const own = (
      h.sqlite
        .prepare("SELECT p.id AS id FROM projects p JOIN team_members m ON m.team_id = p.team_id WHERE m.user_id = ? AND p.event_id = 'evt_01'")
        .get(p.userId) as { id: string } | undefined
    )?.id;
    castBallot(p, "evt_01", null, { projectIds: ["prj_05", "prj_06", "prj_07", "prj_08"].filter((id) => id !== own).slice(0, 3) }, CLIENT);

    expectHttpError(() => saveVotingSettings(org(), "evt_01", { ...settings("2"), reason: "Two is enough" }), 409, "ballots_too_large");
    expect(limitNow()).toBe(3);
    saveVotingSettings(org(), "evt_01", { ...settings("5"), reason: "Five, as announced" });
    expect(limitNow()).toBe(5);
    saveVotingSettings(org(), "evt_01", { ...settings("3"), reason: "Back to three: five was a typo" });
    expect(limitNow()).toBe(3);
  });
});

describe("the counting rules once ballots are in", () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
    countLink: true,
    ...over,
  });
  const REASON = "The announcement said five favourites";
  const firstBallot = () => {
    const p = participant();
    const own = (
      h.sqlite
        .prepare("SELECT p.id AS id FROM projects p JOIN team_members m ON m.team_id = p.team_id WHERE m.user_id = ? AND p.event_id = 'evt_01'")
        .get(p.userId) as { id: string } | undefined
    )?.id;
    castBallot(p, "evt_01", null, { projectIds: ["prj_05", "prj_06"].filter((id) => id !== own).slice(0, 1) }, CLIENT);
  };

  it("known-bad: more favourites, or a way in opened or closed, without a reason is refused — 422, nothing changes, no row", () => {
    openVoting();
    firstBallot();
    const before = getVotingAdmin(org(), "evt_01").settings;
    const rows = auditRows().length;
    expectHttpError(() => saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5" })), 422, "invalid");
    expectHttpError(() => saveVotingSettings(org(), "evt_01", settings({ modes: ["account", "listed"] })), 422, "invalid");
    expectHttpError(() => saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5", reason: "  " })), 422, "invalid");
    expect(getVotingAdmin(org(), "evt_01").settings).toEqual(before);
    expect(auditRows().length).toBe(rows);
    expect(getCommunityResults("evt_01").ruleChanges).toEqual([]);
  });

  it("with a reason the change is saved, audited with it, and listed beside the count for everyone", () => {
    openVoting();
    firstBallot();
    const out = saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5", modes: ["account", "listed"], reason: REASON }));
    expect(out.rulesChanged).toBe(true);
    const [row] = auditRows().filter((r) => r.action === "voting.rules_changed");
    expect(row!.before).toMatchObject({ votesPerVoter: 3, modes: ["account", "link", "listed"] });
    expect(row!.after).toMatchObject({ votesPerVoter: 5, modes: ["account", "listed"], reason: REASON });
    const change = { reason: REASON, before: { modes: ["account", "link", "listed"], votesPerVoter: 3 }, after: { modes: ["account", "listed"], votesPerVoter: 5 } };
    expect(getCommunityResults("evt_01").ruleChanges).toMatchObject([change]);
    expect(getVotingAdmin(org(), "evt_01").settings.ruleChanges).toMatchObject([change]);
    const line = getAuditLog(org(), "evt_01").lines.find((l) => l.action === "voting.rules_changed")!;
    expect(line.parts.map((p) => p.text).join("")).toContain("favourites per voter 3 → 5; closed to the open link");
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("positive controls: before the first ballot no reason is asked and nothing is listed; after it, the window alone moves without one", () => {
    openVoting();
    saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5" }));
    expect(getCommunityResults("evt_01").ruleChanges).toEqual([]);
    firstBallot();
    const out = saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5", votingCloseAt: "2998-01-01T00:00" }));
    expect(out.rulesChanged).toBe(false);
    expect(auditRows().filter((r) => r.action === "voting.rules_changed")).toHaveLength(0);
    expect(getCommunityResults("evt_01").ruleChanges).toEqual([]);
  });

  it("a save that changes the rules and moves the window writes both rows: the window keeps its own sentence", () => {
    openVoting();
    firstBallot();
    const settingsRows = auditCount("voting.settings");
    saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5", votingCloseAt: "2998-06-01T00:00", reason: REASON }));
    expect(auditCount("voting.rules_changed")).toBe(1);
    const windowRows = auditRows().filter((r) => r.action === "voting.settings");
    expect(windowRows).toHaveLength(settingsRows + 1);
    expect(windowRows.at(-1)!.after).toMatchObject({ votingCloseAt: "2998-06-01T00:00:00.000Z", votesPerVoter: 5 });
    const lines = getAuditLog(org(), "evt_01").lines;
    const windowTexts = lines.filter((l) => l.action === "voting.settings").map((l) => l.parts.map((p) => p.text).join(""));
    expect(windowTexts.some((t) => t.includes("2998"))).toBe(true);
    expect(verifyAuditChain(h.db).ok).toBe(true);
    // positive control: a rule change that leaves the window where it is writes no window row
    saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "6", votingCloseAt: "2998-06-01T00:00", reason: REASON }));
    expect(auditCount("voting.rules_changed")).toBe(2);
    expect(auditCount("voting.settings")).toBe(settingsRows + 1);
  });

  it("the organizer overview's recent activity lists a rule change, as it lists a settings save", () => {
    openVoting();
    expect(getOverview(org(), "evt_01").audit.map((l) => l.action)).toContain("voting.settings"); // positive control
    firstBallot();
    saveVotingSettings(org(), "evt_01", settings({ votesPerVoter: "5", reason: REASON }));
    expect(getOverview(org(), "evt_01").audit[0]!.action).toBe("voting.rules_changed");
  });

  it("known-bad: a participant cannot change them, reason or not — 403", () => {
    openVoting();
    firstBallot();
    expectHttpError(() => saveVotingSettings(participant(), "evt_01", settings({ votesPerVoter: "5", reason: REASON })), 403, "not_an_organizer");
  });
});

describe("listed voters", () => {
  beforeEach(() => {
    openVoting();
  });

  it("the audit row names each voter the list gained by voter id, never by address", () => {
    addListedVoters(org(), "evt_01", { emails: "a@example.org, b@example.org" });
    addListedVoters(org(), "evt_01", { emails: "b@example.org, c@example.org" });
    const rows = auditRows().filter((r) => r.action === "voting.voters_added");
    const ids = (email: string) => (h.sqlite.prepare("SELECT id FROM voters WHERE event_id = 'evt_01' AND email = ?").get(email) as { id: string }).id;
    expect(rows.map((r) => (r.after as { voterIds?: string[] }).voterIds)).toEqual([[ids("a@example.org"), ids("b@example.org")], [ids("c@example.org")]]);
    expect(JSON.stringify(rows.map((r) => r.after))).not.toContain("@example.org");
  });

  it("adds each address once (case-insensitive), skips known ones, and their personal links vote as kind listed", () => {
    const first = addListedVoters(org(), "evt_01", { emails: "a@example.org, b@example.org\nA@Example.org" });
    expect(first.links).toHaveLength(2);
    expect(first.skipped).toBe(0);
    expect(first.links.map((l) => l.email).sort()).toEqual(["a@example.org", "b@example.org"]);
    for (const l of first.links) expect(l.path.startsWith("/vote/")).toBe(true);

    const second = addListedVoters(org(), "evt_01", { emails: "a@example.org c@example.org" });
    expect(second.links).toHaveLength(1);
    expect(second.links[0]!.email).toBe("c@example.org");
    expect(second.skipped).toBe(1);

    // a personal link is the voter's own token: entering returns the same token
    const aPath = first.links.find((l) => l.email === "a@example.org")!.path;
    const token = aPath.slice("/vote/".length);
    const entered = enterVoting(token, { ip: "10.0.0.3", agent: "ListedBrowser" });
    expect(entered.token).toBe(token);
    expect(entered.eventId).toBe("evt_01");

    const cast = castBallot(null, "evt_01", token, { projectIds: ["prj_06"] }, CLIENT);
    expect(voterById(cast.voterId)?.kind).toBe("listed");
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", cast.voterId)).toBe(1);
  });

  it("known-bad: an address that is not an address is 422", () => {
    expectHttpError(() => addListedVoters(org(), "evt_01", { emails: "not-an-email" }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM voters WHERE kind = 'listed'")).toBe(0);
  });
});

describe("the voting window", () => {
  beforeEach(() => {
    openVoting();
  });

  it("refuses a ballot after the window with 403 voting_closed", () => {
    const token = linkToken();
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT), 403, "voting_closed");
  });

  it("refuses a ballot before the window with 403 voting_not_open", () => {
    const token = linkToken();
    h.sqlite
      .prepare("UPDATE events SET voting_open_at = '2999-06-01T00:00:00.000Z', voting_close_at = '2999-07-01T00:00:00.000Z' WHERE id = 'evt_01'")
      .run();
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT), 403, "voting_not_open");
  });
});

describe("voiding a voter", () => {
  beforeEach(() => {
    openVoting();
  });

  it("needs a reason; voiding stops the ballot; restoring lets it vote again", () => {
    const token = linkToken();
    const { voterId } = castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT);

    expectHttpError(() => voidVoter(org(), "evt_01", { voterId, reason: "" }), 422, "invalid");
    expect(voterById(voterId)?.voided_at).toBeNull();

    voidVoter(org(), "evt_01", { voterId, reason: "Same browser as another ballot" });
    expect(voterById(voterId)?.voided_at).toBeTruthy();
    expect(auditCount("voter.void")).toBe(1);

    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_02"] }, CLIENT), 403, "voter_voided");

    restoreVoter(org(), "evt_01", { voterId });
    expect(voterById(voterId)?.voided_at).toBeNull();
    const again = castBallot(null, "evt_01", token, { projectIds: ["prj_02"] }, CLIENT);
    expect(again.picks).toEqual(["prj_02"]);
  });

  it("turnout: the ballots by way of voting add up to the ballots counted, a set-aside one in neither", () => {
    const kept = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_01"] }, CLIENT);
    const voided = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_02"] }, CLIENT);
    voidVoter(org(), "evt_01", { voterId: voided.voterId, reason: "Same browser as another ballot" });
    const { turnout } = getVotingAdmin(org(), "evt_01");
    expect(turnout.ballots).toBe(1);
    expect(turnout.voided).toBe(1);
    expect(turnout.byKind.find((k) => k.kind === "link")!.ballots).toBe(1);
    expect(turnout.byKind.reduce((s, k) => s + k.ballots, 0)).toBe(turnout.ballots);
    expect(kept.voterId).toBeTruthy();
  });
});

describe("once the window closes the count is final", () => {
  beforeEach(() => {
    openVoting();
  });

  it("known-bad: after closing, no set-aside, no restore and no window change — 409 voting_closed, count unchanged", () => {
    const kept = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);
    const voided = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);
    voidVoter(org(), "evt_01", { voterId: voided.voterId, reason: "Same browser as another ballot" }); // positive control: allowed while open
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    const before = getCommunityResults("evt_01").tally;
    const rows = auditCount("voter.void") + auditCount("voter.restore") + auditCount("voting.settings");

    expectHttpError(() => voidVoter(org(), "evt_01", { voterId: kept.voterId, reason: "Changed my mind after the count" }), 409, "voting_closed");
    expectHttpError(() => restoreVoter(org(), "evt_01", { voterId: voided.voterId }), 409, "voting_closed");
    expectHttpError(
      () => saveVotingSettings(org(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3" }),
      409,
      "voting_closed",
    );
    expectHttpError(() => saveVotingSettings(org(), "evt_01", { votingOpenAt: "", votingCloseAt: "", modes: ["link"], votesPerVoter: "3" }), 409, "voting_closed");

    expect(getCommunityResults("evt_01").tally).toEqual(before);
    expect(getCommunityResults("evt_01").state).toBe("closed");
    expect(auditCount("voter.void") + auditCount("voter.restore") + auditCount("voting.settings")).toBe(rows);
  });

  it("known-bad: after closing nobody new comes in and no new links are made — 403 for the entry, 409 for the organizer", () => {
    const { code } = makeVotingLink(org(), "evt_01");
    expect(enterVoting(code, { ip: nextIp(), agent: "Agent" }).token).toBeTruthy(); // positive control: entry works while open
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    const voters = () => (h.sqlite.prepare("SELECT count(*) AS n FROM voters WHERE event_id = 'evt_01'").get() as { n: number }).n;
    const before = voters();

    const refusedBefore = auditCount("authz.refused");
    expectHttpError(() => enterVoting(code, { ip: nextIp(), agent: "Agent" }), 403, "voting_closed");
    expectHttpError(() => makeVotingLink(org(), "evt_01"), 409, "voting_closed");
    expectHttpError(() => addListedVoters(org(), "evt_01", { emails: "late@example.org" }), 409, "voting_closed");
    expect(voters()).toBe(before);
    // the 403 is logged like every other: one refusal row, anonymous, naming the code
    const refusals = auditRows().filter((r) => r.action === "authz.refused").slice(refusedBefore);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.actorLabel).toBe("anonymous");
    expect(refusals[0]!.after).toMatchObject({ attempted: "voting.enter", status: 403, code: "voting_closed" });
  });

  it("a participant still gets 403 first, not the 409", () => {
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    expectHttpError(
      () => saveVotingSettings(participant(), "evt_01", { votingOpenAt: "2026-01-01T00:00", votingCloseAt: "2999-01-01T00:00", modes: ["link"], votesPerVoter: "3" }),
      403,
      "not_an_organizer",
    );
  });
});

describe("tallies", () => {
  beforeEach(() => {
    openVoting();
  });

  it("are live for organizers only while the window is open; after closing they are public, sorted, and skip voided voters' picks", () => {
    const t1 = linkToken();
    const t2 = linkToken();
    castBallot(null, "evt_01", t1, { projectIds: ["prj_07"] }, CLIENT);
    const second = castBallot(null, "evt_01", t2, { projectIds: ["prj_07"] }, CLIENT);
    const only = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);

    const live = getVotingAdmin(org(), "evt_01").tally!;
    expect(live.find((x) => x.projectId === "prj_07")?.votes).toBe(2);
    expect(live.find((x) => x.projectId === "prj_08")?.votes).toBe(1);
    expect(live[0].projectId).toBe("prj_07");
    expect(getCommunityResults("evt_01").tally).toBeNull();
    expectHttpError(() => getVotingAdmin(participant(), "evt_01"), 403, "not_an_organizer");

    voidVoter(org(), "evt_01", { voterId: second.voterId, reason: "Same browser as another ballot" });
    voidVoter(org(), "evt_01", { voterId: only.voterId, reason: "Same browser as another ballot" });
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();

    const admin = getVotingAdmin(org(), "evt_01");
    const results = getCommunityResults("evt_01");
    expect(results.state).toBe("closed");
    for (const t of [admin.tally!, results.tally!]) {
      expect(t.map((x) => x.votes)).toEqual([...t.map((x) => x.votes)].sort((a, b) => b - a));
      expect(t.find((x) => x.projectId === "prj_07")?.votes).toBe(1); // one of the two prj_07 ballots was voided
      expect(t.find((x) => x.projectId === "prj_08")?.votes).toBe(0); // its only ballot was voided: listed with 0, not dropped
      expect(t).toHaveLength(41);
      // places: the one project with a vote is first; nobody else has a place, rather than all 40 sharing one
      expect(t.find((x) => x.projectId === "prj_07")?.place).toBe(1);
      expect(t.filter((x) => x.place !== null)).toHaveLength(1);
      expect(t.find((x) => x.projectId === "prj_08")?.place).toBeNull();
    }
  });

  it("equal counts share a place and the next place skips (1, 1, 3); a count of zero has no place", () => {
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07", "prj_08"] }, CLIENT);
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07", "prj_08", "prj_10"] }, { ip: "198.51.100.7", agent: "OtherBrowser" });
    const place = (id: string) => getVotingAdmin(org(), "evt_01").tally!.find((x) => x.projectId === id)?.place;
    expect([place("prj_07"), place("prj_08"), place("prj_10"), place("prj_11")]).toEqual([1, 1, 3, null]);
  });
});

describe("the audit log keeps what a ballot holds sealed until voting closes", () => {
  beforeEach(() => {
    openVoting();
  });

  it("names no pick on the log page or in the CSV while voting is open, and names them once it closes", () => {
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);
    const title = (h.sqlite.prepare("SELECT title FROM projects WHERE id = 'prj_07'").get() as { title: string }).title;
    const text = () => getAuditLog(org(), "evt_01").lines.filter((l) => l.action === "vote.cast").map((l) => l.parts.map((p) => p.text).join(""));

    expect(text()).toHaveLength(1);
    expect(text()[0]).toMatch(/hidden until voting closes/);
    expect(text()[0]).not.toContain(title);
    // the ballot's own line of the CSV (the import's row names prj_07 among the reviews it brought, which is no pick)
    const ballotLine = () => auditCsv(h.db, "evt_01").split(/\r?\n/).filter((l) => l.includes(",vote.cast,"));
    expect(ballotLine()).toHaveLength(1);
    expect(ballotLine()[0]).not.toContain("prj_07");

    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
    expect(text()[0]).toContain(title); // positive control: the same row, readable once closed
    expect(ballotLine()[0]).toContain("prj_07");
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("counts the event's log rows as a plain number for the page", () => {
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);
    const { total } = getAuditLog(org(), "evt_01");
    const rows = (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE event_id = 'evt_01'").get() as { n: number }).n;
    expect(typeof total).toBe("number");
    expect(total).toBe(rows);
  });
});

describe("duplicate detection", () => {
  beforeEach(() => {
    openVoting();
  });

  it("flags two ballots from the same address and browser, and not one from a different address", () => {
    const { code } = makeVotingLink(org(), "evt_01");
    const a = enterVoting(code, { ip: "10.0.0.9", agent: "Same" });
    const b = enterVoting(code, { ip: "10.0.0.9", agent: "Same" });
    const c = enterVoting(code, { ip: "10.0.0.10", agent: "Same" });
    const va = castBallot(null, "evt_01", a.token, { projectIds: ["prj_01"] }, CLIENT);
    const vb = castBallot(null, "evt_01", b.token, { projectIds: ["prj_02"] }, CLIENT);
    const vc = castBallot(null, "evt_01", c.token, { projectIds: ["prj_03"] }, CLIENT);

    const { suspected } = getVotingAdmin(org(), "evt_01");
    const groupOfA = suspected.find((g) => g.voters.some((v) => v.id === va.voterId));
    expect(groupOfA).toBeDefined();
    expect(groupOfA!.voters.map((v) => v.id)).toContain(vb.voterId);
    // c entered from another address: it is in no group
    expect(suspected.some((g) => g.voters.some((v) => v.id === vc.voterId))).toBe(false);
  });
});

describe("rate limits", () => {
  beforeEach(() => {
    openVoting();
  });

  it("allows 8 open-link entries per address; the 9th and 10th are 429 and audited once", () => {
    const { code } = makeVotingLink(org(), "evt_01");
    const client: Client = { ip: "10.1.1.1", agent: "X" };
    for (let i = 0; i < 8; i++) {
      const entered = enterVoting(code, client);
      expect(entered.eventId).toBe("evt_01");
    }
    expect(count("SELECT count(*) AS n FROM voters WHERE kind = 'link'")).toBe(8);

    let limited: RateLimitedError | undefined;
    try {
      enterVoting(code, client);
    } catch (err) {
      limited = err as RateLimitedError;
    }
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited!.status).toBe(429);
    expect(limited!.code).toBe("rate_limited");
    expect(limited!.retryAfter).toBeGreaterThan(0);

    expectHttpError(() => enterVoting(code, client), 429, "rate_limited");
    expect(auditCount("ratelimit.refused")).toBe(1); // one row for both refusals, not one each
    expect(count("SELECT count(*) AS n FROM voters WHERE kind = 'link'")).toBe(8);
  });

  it("unknown voting codes cost an address a try: 30 answer 404, then every code from it waits (429), known or not; one audit row", () => {
    const { code } = makeVotingLink(org(), "evt_01");
    const listed = addListedVoters(org(), "evt_01", { emails: "listed-limit@example.org" }).links[0]!.path.slice("/vote/".length);
    const guesser: Client = { ip: "10.2.2.2", agent: "G" };
    for (let i = 0; i < 30; i++) {
      const guess = `guess-${i}-${"x".repeat(20)}`;
      expectHttpError(() => (i % 2 ? describeVotingCode(guess, guesser) : enterVoting(guess, guesser)), 404, "not_found");
    }
    expect(auditCount("ratelimit.refused")).toBe(0);
    expectHttpError(() => describeVotingCode("guess-30-xxxxxxxxxxxxxxxxxxxx", guesser), 429, "rate_limited");
    // dry: the answers no longer tell a real code from a guess
    expectHttpError(() => describeVotingCode(listed, guesser), 429, "rate_limited");
    expectHttpError(() => enterVoting(listed, guesser), 429, "rate_limited");
    expectHttpError(() => describeVotingCode(code, guesser), 429, "rate_limited");
    expectHttpError(() => enterVoting(code, guesser), 429, "rate_limited");
    expect(auditCount("ratelimit.refused")).toBe(1);
    expect(count("SELECT count(*) AS n FROM voters WHERE kind = 'link'")).toBe(0);
    // positive control: another address is not affected
    const other: Client = { ip: "10.2.2.3", agent: "G" };
    expect(describeVotingCode(listed, other).kind).toBe("listed");
    expect(enterVoting(listed, other).token).toBe(listed);
    expect(describeVotingCode(code, other).kind).toBe("link");
  });

  it("known codes spend no tries: a venue opening real links 100 times from one address still gets 404 for a slip, not 429", () => {
    const listed = addListedVoters(org(), "evt_01", { emails: "venue-listed@example.org" }).links[0]!.path.slice("/vote/".length);
    const venue: Client = { ip: "10.3.3.3", agent: "V" };
    for (let i = 0; i < 100; i++) {
      expect(describeVotingCode(listed, venue).kind).toBe("listed");
      expect(enterVoting(listed, venue).token).toBe(listed);
    }
    expectHttpError(() => describeVotingCode("a-slip-in-the-address-xxxxx", venue), 404, "not_found");
  });

  it("allows a voter 30 ballot saves; the 31st is 429", () => {
    const token = linkToken();
    for (let i = 0; i < 30; i++) {
      castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT);
    }
    expect(auditCount("vote.cast")).toBe(1); // the 29 repeats were no-ops, but each still spent a token
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT), 429, "rate_limited");
  });

  it("known-bad: an account voter's first save and the ones after it share one limit (the 31st is 429)", () => {
    const p = actorById("usr_organizer"); // on no team, so every project is a valid pick
    for (let i = 0; i < 30; i++) {
      castBallot(p, "evt_01", null, { projectIds: ["prj_01"] }, CLIENT);
    }
    expectHttpError(() => castBallot(p, "evt_01", null, { projectIds: ["prj_01"] }, CLIENT), 429, "rate_limited");
  });
});

describe("the seeded ballot order", () => {
  beforeEach(() => {
    openVoting();
  });

  it("differs between link voters and is stable for one voter", () => {
    const t1 = linkToken();
    const t2 = linkToken();
    const t3 = linkToken();
    const orderOf = (token: string) => getBallot(null, "evt_01", token).projects.map((p) => p.id);
    const o1 = orderOf(t1);
    const o2 = orderOf(t2);
    const o3 = orderOf(t3);
    expect(o1).toHaveLength(41);
    expect(new Set([o1.join(), o2.join(), o3.join()]).size).toBeGreaterThanOrEqual(2); // at least two voters see different orders
    expect(orderOf(t1)).toEqual(o1); // the same voter sees the same order twice
  });
});

describe("cross-event tokens", () => {
  it("known-bad: an evt_01 voting token is worthless on another event (401) and leaves no audit row", () => {
    openVoting();
    const token = linkToken();
    h.sqlite
      .prepare(
        `INSERT INTO events (id, slug, name, description, submissions_open_at, submissions_close_at, judging_close_at,
                             voting_open_at, voting_close_at, results_published_at, settings, created_at)
         SELECT 'evt_x', 'x-event', name, description, submissions_open_at, submissions_close_at, judging_close_at,
                voting_open_at, voting_close_at, results_published_at, settings, created_at
         FROM events WHERE id = 'evt_01'`,
      )
      .run();

    const before = auditRows().length;
    expectHttpError(() => castBallot(null, "evt_x", token, { projectIds: ["prj_01"] }, CLIENT), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
  });
});

describe("the count follows merges and team changes", () => {
  const close = () => h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = 'evt_01'").run();
  const votesFor = (id: string) => getCommunityResults("evt_01").tally!.find((t) => t.projectId === id)?.votes;
  const newVoter = (id: string) => {
    h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, `${id}@example.org`, id, NOW);
    return actorById(id);
  };

  it("known-bad: a vote on a merged copy counts for the copy it was merged into, once per voter; undoing the merge gives it back", () => {
    openVoting();
    const x = newVoter("usr_vx");
    const y = newVoter("usr_vy");
    const z = newVoter("usr_vz");
    castBallot(x, "evt_01", null, { projectIds: ["prj_41"] }, CLIENT);
    castBallot(y, "evt_01", null, { projectIds: ["prj_07"] }, CLIENT);
    castBallot(z, "evt_01", null, { projectIds: ["prj_07", "prj_41"] }, CLIENT);

    mergeDuplicate(org(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    // the merged voter's ballot shows the kept copy, and re-saving the old pick is no error
    expect(getBallot(x, "evt_01", null).picks).toEqual(["prj_07"]);
    expect(getBallot(z, "evt_01", null).picks).toEqual(["prj_07"]);

    close();
    expect(votesFor("prj_07")).toBe(3); // x (through the merge), y, z once
    expect(votesFor("prj_41")).toBeUndefined(); // the merged copy has no row of its own

    // undoing the merge (still allowed: results are not published) gives each copy its own votes back
    unmergeDuplicate(org(), "evt_01", { duplicateId: "prj_41" });
    expect(votesFor("prj_41")).toBe(2); // x, z
    expect(votesFor("prj_07")).toBe(2); // y, z
  });

  it("known-bad: a merge or unmerge after the close that moves the final count is recorded beside the count and in its audit row", () => {
    openVoting();
    const x = newVoter("usr_vx");
    const y = newVoter("usr_vy");
    castBallot(x, "evt_01", null, { projectIds: ["prj_41"] }, CLIENT);
    castBallot(y, "evt_01", null, { projectIds: ["prj_07", "prj_41"] }, CLIENT);
    close();
    expect(votesFor("prj_07")).toBe(1);
    expect(votesFor("prj_41")).toBe(2);
    expect(getCommunityResults("evt_01").countChanges).toEqual([]);

    mergeDuplicate(org(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    expect(votesFor("prj_07")).toBe(2); // x through the merge, y once
    const [merged] = getCommunityResults("evt_01").countChanges;
    expect(merged).toMatchObject({ kind: "merge", keep: { id: "prj_07" }, duplicate: { id: "prj_41" } });
    expect(merged!.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: "prj_07", before: 1, after: 2 }),
        expect.objectContaining({ projectId: "prj_41", before: 2, after: null }),
      ]),
    );
    expect(getVotingAdmin(org(), "evt_01").settings.countChanges).toHaveLength(1);
    const mergeRow = auditRows().filter((r) => r.action === "project.merge").at(-1)!;
    expect(mergeRow.after).toMatchObject({ into: "prj_07", countChange: { kind: "merge" } });
    const mergeLine = getAuditLog(org(), "evt_01").lines.find((l) => l.action === "project.merge")!;
    expect(mergeLine.parts.map((p) => p.text).join("")).toContain("after voting closed");
    expect(mergeLine.parts.map((p) => p.text).join("")).toContain("the copy kept 1 vote → 2 votes, the other copy 2 votes → merged");

    unmergeDuplicate(org(), "evt_01", { duplicateId: "prj_41" });
    expect(votesFor("prj_41")).toBe(2);
    const changes = getCommunityResults("evt_01").countChanges;
    expect(changes.map((c) => c.kind)).toEqual(["merge", "unmerge"]);
    expect(changes[1]!.moves).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: "prj_41", before: null, after: 2 })]));
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("positive controls: a merge while voting is open, or one after the close that moves no vote, adds no note", () => {
    openVoting();
    const x = newVoter("usr_vx");
    castBallot(x, "evt_01", null, { projectIds: ["prj_07"] }, CLIENT);
    mergeDuplicate(org(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    unmergeDuplicate(org(), "evt_01", { duplicateId: "prj_41" });
    close();
    const noVotes = getCommunityResults("evt_01").tally!.filter((t) => t.votes === 0 && t.openLink === 0).map((t) => t.projectId);
    mergeDuplicate(org(), "evt_01", { keepId: noVotes[0]!, duplicateId: noVotes[1]! });
    expect(getCommunityResults("evt_01").countChanges).toEqual([]);
    expect((auditRows().filter((r) => r.action === "project.merge").at(-1)!.after as Record<string, unknown>).countChange).toBeUndefined();
  });

  it("known-bad: refused entries after the close are bounded by the entry limit, so the public link cannot grow the log without end", () => {
    openVoting();
    const { code } = makeVotingLink(org(), "evt_01");
    close();
    const refusals = () => auditRows().filter((r) => r.action === "authz.refused" && (r.after as { attempted?: string } | null)?.attempted === "voting.enter").length;
    const before = refusals();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      try {
        enterVoting(code, { ip: "10.77.0.1", agent: "Spammer" });
      } catch (err) {
        if (err instanceof RateLimitedError) limited++;
      }
    }
    expect(limited).toBeGreaterThan(0);
    expect(refusals() - before).toBeLessThanOrEqual(8);
    expect(refusals() - before).toBeGreaterThan(0); // positive control: the refusals are still logged
  });

  it("positive control: without the merge each copy keeps its own votes", () => {
    openVoting();
    castBallot(newVoter("usr_vx"), "evt_01", null, { projectIds: ["prj_41"] }, CLIENT);
    castBallot(newVoter("usr_vz"), "evt_01", null, { projectIds: ["prj_07", "prj_41"] }, CLIENT);
    close();
    expect(votesFor("prj_41")).toBe(2);
    expect(votesFor("prj_07")).toBe(1);
  });

  it("known-bad: a vote for a project whose team the voter joins afterwards does not count; another voter's does", () => {
    h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
    openVoting();
    const captain = newVoter("usr_cap");
    const team = createTeam(captain, "evt_01", { name: "Late Joiners" });
    h.sqlite
      .prepare("INSERT INTO projects (id, event_id, team_id, track_id, title, summary, status, submitted_at, created_at, updated_at) VALUES ('prj_late', 'evt_01', ?, 'trk_01', 'Late Kite', 'one line', 'submitted', ?, ?, ?)")
      .run(team.id, NOW, NOW, NOW);
    const joiner = newVoter("usr_joiner2");
    const outsider = newVoter("usr_outsider2");
    castBallot(joiner, "evt_01", null, { projectIds: ["prj_late"] }, CLIENT);
    castBallot(outsider, "evt_01", null, { projectIds: ["prj_late"] }, CLIENT);
    const code = (h.sqlite.prepare("SELECT invite_code AS c FROM teams WHERE id = ?").get(team.id) as { c: string }).c;
    joinTeam(actorById("usr_joiner2"), code);
    close();
    expect(votesFor("prj_late")).toBe(1); // the outsider's
  });
});
