// A fresh personal link for one address on the voter list: only this event's organizers
// may make one, and only while the vote can still change. The old link dies the moment
// the new one is made; the new code rests nowhere but its hash — not in the voters row,
// the audit log or the outbox — and a ballot set aside gets no new link until it counts again.

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { setMailTransportForTests } from "@/server/mail";
import { mailVoterLinks } from "@/server/dal/mailing";
import { sha256 } from "@/server/util";
import { castBallot, enterVoting, type Client } from "@/server/dal/voting";
import {
  addListedVoters,
  newVoterLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
} from "@/server/dal/voting-organizer";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-28T12:00:00.000Z";
const EVENT = "evt_01";

let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW);
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

/** A judge of evt_01, as the fixture imports one: an account whose only role here is judge. */
function judge(): Actor {
  const row = h.sqlite
    .prepare("SELECT u.id AS id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.event_id = ? AND r.role = 'judge' LIMIT 1")
    .get(EVENT) as { id: string } | undefined;
  if (!row) throw new Error("no judge of evt_01 in the fixture");
  return actorById(row.id);
}

const CLIENT: Client = { ip: "10.0.0.5", agent: "VoterBrowser" };

/** The standard open window, as tests/voting.test.ts opens before touching the voter list. */
const openVoting = () =>
  saveVotingSettings(org(), EVENT, {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
    countLink: true,
  });

/** The address's first personal link, as the voting page makes it. */
function listAddress(email: string): { email: string; path: string } {
  const { links } = addListedVoters(org(), EVENT, { emails: email });
  return links[0]!;
}

/** The secret in a link: the last path segment, the part that must never rest in a row. */
const codeOf = (link: { path: string }) => link.path.slice("/vote/".length);

/** The voters row for one listed address of evt_01, whole, so every column can be checked. */
const voterRow = (email: string) =>
  h.sqlite.prepare("SELECT * FROM voters WHERE event_id = ? AND email = ?").get(EVENT, email) as
    | { id: string; kind: string; token_hash: string; voided_at: string | null }
    | undefined;

describe("who may make a new link", () => {
  it("no session 401; a participant and a judge of the event 403 not_an_organizer; the voter's token hash never moves", () => {
    openVoting();
    const email = "ann.lee@example.org";
    listAddress(email);
    const before = voterRow(email)!.token_hash;

    expectHttpError(() => newVoterLink(null, EVENT, { email }), 401, "unauthenticated");
    expectHttpError(() => newVoterLink(participant(), EVENT, { email }), 403, "not_an_organizer");
    expectHttpError(() => newVoterLink(judge(), EVENT, { email }), 403, "not_an_organizer");

    expect(voterRow(email)!.token_hash).toBe(before);
    expect(auditCount("voter.new_link")).toBe(0);
  });
});

describe("the address must be on this event's list", () => {
  it("an address never listed is 404; one listed in another event is 404 here (and really exists there)", () => {
    openVoting();
    expectHttpError(() => newVoterLink(org(), EVENT, { email: "stranger@example.org" }), 404, "not_found");

    // a second event with its own voter list, as tests/voting.test.ts makes another event
    h.sqlite
      .prepare(
        `INSERT INTO events (id, slug, name, description, submissions_open_at, submissions_close_at, judging_close_at,
                             voting_open_at, voting_close_at, results_published_at, settings, created_at)
         SELECT 'evt_x', 'x-event', name, description, submissions_open_at, submissions_close_at, judging_close_at,
                voting_open_at, voting_close_at, results_published_at, settings, created_at
         FROM events WHERE id = 'evt_01'`,
      )
      .run();
    h.sqlite.prepare("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, ?, 'organizer', ?)").run("usr_organizer", "evt_x", NOW);
    addListedVoters(org(), "evt_x", { emails: "elsewhere@example.org" });
    expect(count("SELECT count(*) AS n FROM voters WHERE event_id = 'evt_x' AND kind = 'listed'")).toBe(1); // positive control: it exists — in the other event

    expectHttpError(() => newVoterLink(org(), EVENT, { email: "elsewhere@example.org" }), 404, "not_found");
    expect(count("SELECT count(*) AS n FROM voters WHERE event_id = 'evt_01' AND email = 'elsewhere@example.org'")).toBe(0);
  });
});

describe("the new link replaces the old", () => {
  it("the first link's code is refused like a dead one, the second votes; the row holds only the new hash, never a code", () => {
    openVoting();
    const email = "ann.lee@example.org";
    const first = listAddress(email);
    const firstHash = voterRow(email)!.token_hash;
    expect(firstHash).toBe(sha256(codeOf(first)));

    const made = newVoterLink(org(), EVENT, { email });
    expect(made.email).toBe(email);
    expect(made.path.startsWith("/vote/")).toBe(true);
    const code = codeOf(made);

    // the first link died at once: its code is refused where a dead code is refused
    expectHttpError(() => enterVoting(codeOf(first), { ip: "10.0.0.3", agent: "OldLinkBrowser" }), 404, "not_found");

    // the new link is the listed voter's own token, and it votes
    const entered = enterVoting(code, { ip: "10.0.0.4", agent: "NewLinkBrowser" });
    expect(entered.token).toBe(code);
    expect(entered.eventId).toBe(EVENT);
    const cast = castBallot(null, EVENT, code, { projectIds: ["prj_06"] }, CLIENT);
    expect(voterRow(email)!.kind).toBe("listed");
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", cast.voterId)).toBe(1);

    // the row's hash changed to the new code's, and no column holds either code in plain text
    const row = voterRow(email)!;
    expect(row.token_hash).toBe(sha256(code));
    expect(row.token_hash).not.toBe(firstHash);
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(code);
      expect(String(value)).not.toContain(codeOf(first));
    }
  });
});

describe("the address is matched trimmed and lower-case", () => {
  it('"  Ann.Lee@Example.org  " finds the row listed as ann.lee@example.org', () => {
    openVoting();
    const email = "ann.lee@example.org";
    const first = listAddress(email);

    const made = newVoterLink(org(), EVENT, { email: "  Ann.Lee@Example.org  " });
    expect(made.email).toBe(email);
    const code = codeOf(made);

    expect(voterRow(email)!.token_hash).toBe(sha256(code));
    expect(voterRow(email)!.token_hash).not.toBe(sha256(codeOf(first))); // the same row was found, not a second one
    expect(enterVoting(code, { ip: "10.0.0.6", agent: "TypedBrowser" }).eventId).toBe(EVENT);
  });
});

describe("a ballot set aside", () => {
  it("gets no new link (409 voter_set_aside, token unchanged) until it is counted again", () => {
    openVoting();
    const email = "ann.lee@example.org";
    listAddress(email);
    const row = voterRow(email)!;

    voidVoter(org(), EVENT, { voterId: row.id, reason: "Same browser as another ballot" });
    expect(voterRow(email)!.voided_at).toBeTruthy();
    expectHttpError(() => newVoterLink(org(), EVENT, { email }), 409, "voter_set_aside");
    expect(voterRow(email)!.token_hash).toBe(row.token_hash);

    restoreVoter(org(), EVENT, { voterId: row.id });
    const made = newVoterLink(org(), EVENT, { email });
    expect(voterRow(email)!.token_hash).toBe(sha256(codeOf(made)));
  });
});

describe("a final vote", () => {
  it("refuses newVoterLink exactly as addListedVoters once results are published, and once the window has closed (409, token unchanged)", () => {
    openVoting();
    const email = "ann.lee@example.org";
    listAddress(email);
    const before = voterRow(email)!.token_hash;

    // results published: the vote is over
    h.sqlite.prepare("UPDATE events SET results_published_at = ? WHERE id = ?").run(NOW, EVENT);
    expectHttpError(() => addListedVoters(org(), EVENT, { emails: "late@example.org" }), 409, "results_published");
    expectHttpError(() => newVoterLink(org(), EVENT, { email }), 409, "results_published");

    // the window closed too (published results cannot be withdrawn, so it closes on top): voteFinal names the closed window first
    h.sqlite.prepare("UPDATE events SET voting_close_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(EVENT);
    expectHttpError(() => addListedVoters(org(), EVENT, { emails: "late@example.org" }), 409, "voting_closed");
    expectHttpError(() => newVoterLink(org(), EVENT, { email }), 409, "voting_closed");

    expect(voterRow(email)!.token_hash).toBe(before);
  });
});

describe("the audit row", () => {
  it("is one voter.new_link row aimed at the voter, holding neither code", () => {
    openVoting();
    const email = "ann.lee@example.org";
    const first = listAddress(email);
    const made = newVoterLink(org(), EVENT, { email });

    const rows = auditRows().filter((r) => r.action === "voter.new_link");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.targetType).toBe("voter");
    expect(row.targetId).toBe(voterRow(email)!.id);
    expect(row.eventId).toBe(EVENT);
    expect(row.actorUserId).toBe("usr_organizer");

    const json = `${JSON.stringify(row.before)}${JSON.stringify(row.after)}`;
    expect(json).not.toContain(codeOf(made));
    expect(json).not.toContain(codeOf(first));
  });
});

describe("mailing the new link", () => {
  /** The env the mail module reads at run time; saved and put back around each test. */
  const ENV_KEYS = ["SMTP_URL", "MAIL_FROM", "PUBLIC_URL"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.SMTP_URL = "smtp://mail.test:25";
    process.env.MAIL_FROM = "portal@mail.test";
    process.env.PUBLIC_URL = "https://portal.example.org";
  });

  afterEach(() => {
    setMailTransportForTests(null);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  type TransportMessage = { from: string; to: string; subject: string; text: string };
  const sentByTransport: TransportMessage[] = [];
  const recordingTransport = { sendMail: async (m: TransportMessage) => void sentByTransport.push(m) };

  type OutboxRow = { id: string; event_id: string | null; kind: string; to_email: string; subject: string; body: string; status: string };
  const outboxAll = () => h.sqlite.prepare("SELECT * FROM outbox").all() as OutboxRow[];

  it("sends one message to the address with the full link, and the outbox row holds neither the new code nor the old one", async () => {
    openVoting();
    const first = listAddress("ann.lee@example.org");
    const made = newVoterLink(org(), EVENT, { email: "ann.lee@example.org" });
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;

    const out = await mailVoterLinks(org(), EVENT, [made]);

    expect(out).toEqual({ on: true, mailed: [{ to: "ann.lee@example.org", status: "sent" }] });
    expect(sentByTransport).toHaveLength(1);
    expect(sentByTransport[0]!.from).toBe("portal@mail.test");
    expect(sentByTransport[0]!.to).toBe("ann.lee@example.org");
    expect(sentByTransport[0]!.text).toContain("https://portal.example.org");
    expect(sentByTransport[0]!.text).toContain(made.path);

    const rows = outboxAll();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("voter_link");
    expect(row.event_id).toBe(EVENT);
    expect(row.to_email).toBe("ann.lee@example.org");
    expect(row.status).toBe("sent");
    expect(row.body).not.toContain(codeOf(made));
    expect(row.body).not.toContain(codeOf(first));
    expect(row.subject).not.toContain(codeOf(made));
    expect(row.subject).not.toContain(codeOf(first));
  });
});
