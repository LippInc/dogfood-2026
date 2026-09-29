// The sending side of the portal's mail: each link is mailed only by whoever was allowed to
// make it and only while SMTP_URL is set; every message is recorded in the outbox with the
// link blanked, so no token ever rests in a row; and a bulk send to a dead server stops
// offering messages after the first few, reporting the rest as never tried.

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { setMailTransportForTests } from "@/server/mail";
import { BLANKED, mailClaimLinks, mailJudgeInvite, mailPasswordReset, mailVoterLinks, setMailWaitForTests } from "@/server/dal/mailing";
import { listOutbox, listPortalOutbox } from "@/server/dal/outbox";
import { inviteJudge } from "@/server/dal/judges";
import { addListedVoters, saveVotingSettings } from "@/server/dal/voting-organizer";
import { makeClaimLinks } from "@/server/dal/claims";
import { makePasswordReset } from "@/server/dal/password-resets";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-28T02:00:00.000Z";
const EVENT = "evt_01";
/** The env the mail module reads at run time; saved and put back around each test. */
const ENV_KEYS = ["SMTP_URL", "MAIL_FROM", "PUBLIC_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

let h: Handle;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SMTP_URL = "smtp://mail.test:25";
  process.env.MAIL_FROM = "portal@mail.test";
  process.env.PUBLIC_URL = "https://portal.example.org";
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW); // usr_organizer: administrator and organizer of evt_01
  const addUser = h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  addUser.run("usr_admin", "admin@example.org", "Ada Admin", null, 1, NOW); // an administrator with no event roles
  addUser.run("usr_org_plain", "org@example.org", "Ola Organizer", "not-a-real-hash", 0, NOW); // an organizer who is not an administrator
  addUser.run("usr_target", "target@example.org", "Tara Target", "not-a-real-hash", 0, NOW); // the account a reset link is made for
  h.sqlite.prepare("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, ?, 'organizer', ?)").run("usr_org_plain", EVENT, NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setMailTransportForTests(null);
  setHandleForTests(null);
  h.sqlite.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// --- helpers, in the shape of tests/outbox.test.ts and tests/password-reset.test.ts ---

function expectHttpErrorAsync(call: () => Promise<unknown>, status: number, code: string) {
  return call().then(
    () => {
      throw new Error("expected the call to throw");
    },
    (err) => {
      expect(err, "expected the call to throw").toBeInstanceOf(HttpError);
      const error = err as HttpError;
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
    },
  );
}

const nOf = (sql: string, ...params: (string | number)[]) => (h.sqlite.prepare(sql).get(...params) as { n: number }).n;
const one = <T>(sql: string, ...params: (string | number)[]) => h.sqlite.prepare(sql).get(...params) as T;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

type OutboxRow = {
  id: string;
  event_id: string | null;
  kind: string;
  to_email: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  sent_at: string | null;
};
const outboxAll = () => h.sqlite.prepare("SELECT * FROM outbox").all() as OutboxRow[];

/** An actor as the session layer would build it, with the admin flag read from the row. */
function actorIn(userId: string): Actor {
  const u = one<{ id: string; name: string; email: string; isAdmin: number }>(
    "SELECT id, name, email, is_admin AS isAdmin FROM users WHERE id = ?",
    userId,
  );
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = h.sqlite
    .prepare("SELECT event_id AS eventId, role FROM user_roles WHERE user_id = ?")
    .all(userId) as Actor["roles"];
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin === 1, roles, sessionKind: "login" };
}

const organizer = () => actorIn("usr_organizer");

/** A member of a team whose kept project is submitted, as tests/outbox.test.ts finds one. */
function participant(): Actor {
  const row = one<{ id: string }>(
    "SELECT tm.user_id AS id FROM team_members tm " +
      "JOIN projects p ON p.team_id = tm.team_id " +
      "WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = ? LIMIT 1",
    EVENT,
  );
  if (!row) throw new Error("no participant on a submitted team in the fixture");
  return actorIn(row.id);
}

// --- the link-makers the mailing functions are handed, called as their own tests call them ---

/** The standard open window, as tests/voting.test.ts opens before addListedVoters. */
const openVoting = () =>
  saveVotingSettings(organizer(), EVENT, {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
    countLink: true,
  });

/** Personal voting links for the addresses given. */
function voterLinks(emails: string[]): { email: string; path: string }[] {
  openVoting();
  const { links } = addListedVoters(organizer(), EVENT, { emails: emails.join(", ") });
  return links;
}

/** A judge invitation with a bound address, as tests/judge-invites.test.ts makes one. */
function judgeInvite(email: string) {
  return inviteJudge(organizer(), EVENT, { name: "Mira", email, trackIds: ["trk_01"] });
}

/** The secret in a link: the last path segment, the only part that must never rest in a row. */
const tokenOf = (link: { path: string }) => link.path.split("/").pop()!;

// --- transports ---

type TransportMessage = { from: string; to: string; subject: string; text: string };
const sentByTransport: TransportMessage[] = [];
const recordingTransport = { sendMail: async (m: TransportMessage) => void sentByTransport.push(m) };

/** A transport that rejects with an SMTP-style code — every message, or one address's only — remembering whose messages it saw. */
function rejectingTransport(code: string, message: string, onlyTo?: string) {
  const seen: string[] = [];
  return {
    seen,
    transport: {
      sendMail: async (m: TransportMessage) => {
        seen.push(m.to);
        if (onlyTo === undefined || m.to === onlyTo) {
          const err = new Error(message) as Error & { code: string };
          err.code = code;
          throw err;
        }
      },
    },
  };
}

// --- the checks ---

describe("the permission check, before anything is sent", () => {
  it("no session 401; a participant 403 not_an_organizer on the three event kinds; a mere organizer 403 not_an_admin on a reset; the transport is never called and no outbox row exists", async () => {
    setMailTransportForTests(recordingTransport); // email is on: had the check come later, a send would have gone out
    sentByTransport.length = 0;
    const invite = judgeInvite("mira@example.org");
    const links = voterLinks(["voter@example.org"]);
    const reset = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });

    await expectHttpErrorAsync(() => mailJudgeInvite(null, EVENT, { email: "mira@example.org", path: invite.path }), 401, "unauthenticated");
    await expectHttpErrorAsync(() => mailVoterLinks(null, EVENT, links), 401, "unauthenticated");
    await expectHttpErrorAsync(() => mailClaimLinks(null, EVENT, []), 401, "unauthenticated");
    await expectHttpErrorAsync(() => mailPasswordReset(null, { email: reset.email, path: reset.path }), 401, "unauthenticated");

    const part = participant();
    await expectHttpErrorAsync(() => mailJudgeInvite(part, EVENT, { email: "mira@example.org", path: invite.path }), 403, "not_an_organizer");
    await expectHttpErrorAsync(() => mailVoterLinks(part, EVENT, links), 403, "not_an_organizer");
    await expectHttpErrorAsync(() => mailClaimLinks(part, EVENT, []), 403, "not_an_organizer");
    await expectHttpErrorAsync(() => mailPasswordReset(actorIn("usr_org_plain"), { email: reset.email, path: reset.path }), 403, "not_an_admin");

    expect(sentByTransport).toHaveLength(0);
    expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(0);
  });
});

describe("email off", () => {
  it("with SMTP_URL unset the link is made but nothing is sent, recorded or audited", async () => {
    delete process.env.SMTP_URL;
    const invite = judgeInvite("mira@example.org");
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;

    const out = await mailJudgeInvite(organizer(), EVENT, { email: "mira@example.org", path: invite.path });

    expect(out).toEqual({ on: false, mailed: [] });
    expect(sentByTransport).toHaveLength(0);
    expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(0);
    expect(auditRows().filter((r) => r.action === "mail.sent")).toHaveLength(0);
  });
});

describe("a judge invitation, sent and recorded", () => {
  it("goes to the one address from MAIL_FROM with the full link, and the outbox keeps it blanked", async () => {
    const invite = judgeInvite("mira@example.org");
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;

    const out = await mailJudgeInvite(organizer(), EVENT, { email: "mira@example.org", path: invite.path });

    expect(out).toEqual({ on: true, mailed: [{ to: "mira@example.org", status: "sent" }] });
    expect(sentByTransport).toHaveLength(1);
    expect(sentByTransport[0]!.from).toBe("portal@mail.test");
    expect(sentByTransport[0]!.to).toBe("mira@example.org");
    expect(sentByTransport[0]!.text).toContain("https://portal.example.org");
    expect(sentByTransport[0]!.text).toContain(invite.path);

    const rows = outboxAll();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.kind).toBe("judge_invite");
    expect(row.event_id).toBe(EVENT);
    expect(row.to_email).toBe("mira@example.org");
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
    expect(row.body).toContain(BLANKED);
    expect(row.body).not.toContain(invite.code);
    expect(row.body).not.toContain(invite.path);

    // two audited writes: the record before the send, then its outcome
    const mailed = auditRows().filter((r) => r.action === "mail.sent");
    expect(mailed.map((r) => r.after)).toEqual([{ kind: "judge_invite", sending: 1 }, { kind: "judge_invite", sent: 1, failed: 0 }]);
  });

  it("records the message as sending before it is handed to the mail server, so no message goes out unrecorded", async () => {
    const invite = judgeInvite("mira@example.org");
    const atSend: { status: string; body: string }[] = [];
    setMailTransportForTests({
      sendMail: async () => {
        atSend.push(...(h.sqlite.prepare("SELECT status, body FROM outbox").all() as { status: string; body: string }[]));
      },
    });
    const out = await mailJudgeInvite(organizer(), EVENT, { email: "mira@example.org", path: invite.path });
    expect(out.mailed).toEqual([{ to: "mira@example.org", status: "sent" }]);
    expect(atSend).toHaveLength(1); // the row existed while the message was being sent
    expect(atSend[0]!.status).toBe("sending");
    expect(atSend[0]!.body).toContain(BLANKED);
    expect(outboxAll()[0]!.status).toBe("sent");
  });

  it("an outbox that cannot record the message means it is not sent; the page still gets its answer (the link's only copy)", async () => {
    const invite = judgeInvite("mira@example.org");
    h.sqlite.exec("CREATE TRIGGER outbox_test_no_insert BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await mailJudgeInvite(organizer(), EVENT, { email: "mira@example.org", path: invite.path });
      expect(out).toEqual({ on: true, mailed: [{ to: "mira@example.org", status: "failed", error: "not sent: the portal could not record it first" }] });
      expect(sentByTransport).toHaveLength(0); // nothing went out unrecorded
      expect(auditRows().filter((r) => r.action === "mail.sent")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("an outcome that cannot be written leaves the row at sending, never lost; the page still gets its answer", async () => {
    const invite = judgeInvite("mira@example.org");
    h.sqlite.exec("CREATE TRIGGER outbox_test_no_update BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    setMailTransportForTests(recordingTransport);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      const out = await mailJudgeInvite(organizer(), EVENT, { email: "mira@example.org", path: invite.path });
      expect(out.mailed).toEqual([{ to: "mira@example.org", status: "sent" }]);
      expect(outboxAll().map((r) => r.status)).toEqual(["sending"]);
      expect(logged.some((l) => l.includes("still say sending"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("a subject past the outbox's 200 characters (a long imported event name) is cut to fit, in the mail and its record alike", async () => {
    const invite = judgeInvite("long@example.org");
    // an imported event's name is not held to the form's 80 characters; this one pushes the subject past the outbox's 200
    h.sqlite.prepare("UPDATE events SET name = ? WHERE id = ?").run("N".repeat(250), EVENT);
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;
    const out = await mailJudgeInvite(organizer(), EVENT, { email: "long@example.org", path: invite.path });
    expect(out).toEqual({ on: true, mailed: [{ to: "long@example.org", status: "sent" }] });
    expect(sentByTransport).toHaveLength(1);
    const rows = outboxAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    expect(rows[0]!.subject).toHaveLength(200);
    expect(rows[0]!.subject.endsWith("…")).toBe(true);
    expect(sentByTransport[0]!.subject).toBe(rows[0]!.subject);
  });

  it("an invitation made without an address mails nothing", async () => {
    const open = inviteJudge(organizer(), EVENT, { name: "No Address", email: "", trackIds: ["trk_02"] });
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;

    const out = await mailJudgeInvite(organizer(), EVENT, { email: null, path: open.path });

    expect(out).toEqual({ on: true, mailed: [] });
    expect(sentByTransport).toHaveLength(0);
    expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(0);
  });
});

describe("no key at rest, every kind", () => {
  it("after mailing voter, claim and reset links no outbox body or subject holds any token; the reset is a portal row, the rest the event's", async () => {
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;
    const voters = voterLinks(["v1@example.org", "v2@example.org", "v3@example.org"]);
    const claims = makeClaimLinks(organizer(), EVENT).links;
    const reset = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });

    const voterOut = await mailVoterLinks(organizer(), EVENT, voters);
    const claimOut = await mailClaimLinks(organizer(), EVENT, claims);
    const resetOut = await mailPasswordReset(actorIn("usr_admin"), { email: "target@example.org", path: reset.path });

    expect(voterOut.mailed).toEqual(voters.map((l) => ({ to: l.email, status: "sent" })));
    expect(claimOut.mailed.every((m) => m.status === "sent")).toBe(true);
    expect(resetOut.mailed).toEqual([{ to: "target@example.org", status: "sent" }]);

    const tokens = [...voters, ...claims, reset].map(tokenOf);
    expect(tokens.every(Boolean)).toBe(true); // every link really ends in a secret
    const rows = outboxAll();
    expect(rows).toHaveLength(voters.length + claims.length + 1);
    for (const row of rows) {
      for (const token of tokens) {
        expect(row.body).not.toContain(token);
        expect(row.subject).not.toContain(token);
      }
    }

    const byKind = (kind: string) => rows.filter((r) => r.kind === kind);
    expect(byKind("voter_link")).toHaveLength(3);
    expect(byKind("claim_link")).toHaveLength(claims.length);
    const resetRows = byKind("password_reset");
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0]!.event_id).toBeNull();
    expect(resetRows.map((r) => r.id)).toEqual(listPortalOutbox(actorIn("usr_admin")).messages.map((r) => r.id)); // the portal row alone
    // the event's rows (a page holds the newest 100, and here there may be more): each one it gives is the event's, never the portal's
    const eventIds = new Set(rows.filter((r) => r.event_id === EVENT).map((r) => r.id));
    const read = listOutbox(organizer(), EVENT);
    expect(read.messages).toHaveLength(Math.min(100, eventIds.size));
    expect(read.messages.every((r) => eventIds.has(r.id))).toBe(true);
    expect(read.counts.total).toBe(eventIds.size);
  });
});

describe("a bulk send against a dead server", () => {
  it("fails all ten voter links after at most four attempts, the untried ones saying so, and records ten failed rows", async () => {
    const down = rejectingTransport("ECONNECTION", "the server is gone");
    setMailTransportForTests(down.transport);
    const emails = Array.from({ length: 10 }, (_, i) => `down${i}@example.org`);
    const links = voterLinks(emails);

    const out = await mailVoterLinks(organizer(), EVENT, links);

    expect(out.on).toBe(true);
    expect(out.mailed).toHaveLength(10);
    expect(out.mailed.every((m) => m.status === "failed")).toBe(true);
    expect(down.seen.length).toBeLessThanOrEqual(4); // once the server is down, the rest are not offered
    const seen = new Set(down.seen);
    const untried = out.mailed.filter((m) => !seen.has(m.to));
    expect(untried.length).toBe(10 - down.seen.length);
    expect(untried.length).toBeGreaterThan(0); // the check below had something to check
    for (const m of untried) expect(m.error).toMatch(/^not tried: /);

    const rows = outboxAll();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.error).toBeTruthy();
    }
    const mailed = auditRows().filter((r) => r.action === "mail.sent");
    expect(mailed.map((r) => r.after)).toEqual([{ kind: "voter_link", sending: 10 }, { kind: "voter_link", sent: 0, failed: 10 }]);
  });
});

describe("a bulk send with one bad recipient", () => {
  it("fails that one address alone; every other message still goes out", async () => {
    const bad = "bad@example.org";
    const picky = rejectingTransport("EENVELOPE", `${bad} refused the message`, bad);
    setMailTransportForTests(picky.transport);
    const links = voterLinks(["good1@example.org", bad, "good2@example.org", "good3@example.org", "good4@example.org"]);

    const out = await mailVoterLinks(organizer(), EVENT, links);

    expect(picky.seen).toHaveLength(5); // a bad envelope is not a dead server: everything is tried
    const byTo = new Map(out.mailed.map((m) => [m.to, m]));
    expect(byTo.get(bad)!.status).toBe("failed");
    expect(byTo.get(bad)!.error).toContain("refused the message");
    for (const m of out.mailed.filter((x) => x.to !== bad)) {
      expect(m.status).toBe("sent");
      expect(m.error).toBeUndefined();
    }
  });
});

describe("a slow mail server", () => {
  it("does not hold the page: past the wait the links come back with pending, and the sends still finish and record their outcome", async () => {
    const links = voterLinks(["slow1@example.org", "slow2@example.org"]);
    const delivered: string[] = [];
    setMailTransportForTests({
      sendMail: (m: TransportMessage) => new Promise<void>((resolve) => setTimeout(() => resolve(void delivered.push(m.to)), 400)),
    });
    setMailWaitForTests(50);
    try {
      const started = Date.now();
      const out = await mailVoterLinks(organizer(), EVENT, links);
      expect(Date.now() - started).toBeLessThan(350); // answered before the server did
      expect(out).toEqual({ on: true, mailed: [{ to: "slow1@example.org", status: "pending" }, { to: "slow2@example.org", status: "pending" }] });
      expect(outboxAll().map((r) => r.status)).toEqual(["sending", "sending"]); // recorded before the answer
      await vi.waitFor(() => expect(outboxAll().map((r) => r.status)).toEqual(["sent", "sent"]), { timeout: 3000, interval: 50 });
      expect(delivered.sort()).toEqual(["slow1@example.org", "slow2@example.org"]);
      const mailed = auditRows().filter((r) => r.action === "mail.sent");
      expect(mailed.map((r) => r.after)).toEqual([{ kind: "voter_link", sending: 2 }, { kind: "voter_link", sent: 2, failed: 0 }]);
    } finally {
      setMailWaitForTests(null);
    }
  });

  it("positive control: a server that answers within the wait gives the outcome itself, not pending", async () => {
    const links = voterLinks(["quick@example.org"]);
    setMailTransportForTests({ sendMail: (m: TransportMessage) => new Promise<void>((resolve) => setTimeout(() => resolve(void sentByTransport.push(m)), 20)) });
    setMailWaitForTests(2000);
    try {
      const out = await mailVoterLinks(organizer(), EVENT, links);
      expect(out.mailed).toEqual([{ to: "quick@example.org", status: "sent" }]);
    } finally {
      setMailWaitForTests(null);
    }
  });
});
