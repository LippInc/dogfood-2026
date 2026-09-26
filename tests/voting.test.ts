import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, useHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError, RateLimitedError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { sha256 } from "@/server/util";
import {
  addListedVoters,
  castBallot,
  enterVoting,
  getBallot,
  getCommunityResults,
  getVotingAdmin,
  makeVotingLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
  type Client,
} from "@/server/dal/voting";
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
  useHandleForTests(h); // the voting DAL goes through getDb()
});

afterEach(() => {
  useHandleForTests(null);
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

/** The standard open window: all three ways to vote, three picks each. */
const openVoting = () =>
  saveVotingSettings(org(), "evt_01", {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
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

describe("listed voters", () => {
  beforeEach(() => {
    openVoting();
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
});

describe("tallies", () => {
  beforeEach(() => {
    openVoting();
  });

  it("stay hidden from everyone while the window is open; after closing they are sorted and skip voided voters' picks", () => {
    const t1 = linkToken();
    const t2 = linkToken();
    castBallot(null, "evt_01", t1, { projectIds: ["prj_07"] }, CLIENT);
    const second = castBallot(null, "evt_01", t2, { projectIds: ["prj_07"] }, CLIENT);
    const only = castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_08"] }, CLIENT);

    expect(getVotingAdmin(org(), "evt_01").tally).toBeNull();
    expect(getCommunityResults("evt_01").tally).toBeNull();

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
    }
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

  it("allows a voter 30 ballot saves; the 31st is 429", () => {
    const token = linkToken();
    for (let i = 0; i < 30; i++) {
      castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT);
    }
    expect(auditCount("vote.cast")).toBe(1); // the 29 repeats were no-ops, but each still spent a token
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_01"] }, CLIENT), 429, "rate_limited");
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
