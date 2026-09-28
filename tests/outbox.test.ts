// The portal's outgoing mail: every message leaves an outbox row whose shape the database
// itself polices (known kinds and statuses, an address with an @, a sent row always stamped);
// sending goes through one mail module that is off until SMTP_URL is set and never throws,
// however the transport fails; and an event's organizer can read that event's rows, an
// administrator the portal's own — nobody else, with every refusal audited.

import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { mailProblem, mailSettings, sendMail, setMailTransportForTests } from "@/server/mail";
import { listOutbox, listPortalOutbox, type OutboxView } from "@/server/dal/outbox";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-28T02:00:00.000Z";
const EVENT = "evt_01";
const ON_ENV = { SMTP_URL: "smtp://mail.test:25", MAIL_FROM: "portal@mail.test" };

let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW); // usr_organizer: administrator and organizer of evt_01
  const addUser = h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, null, ?, ?)");
  addUser.run("usr_admin", "admin@example.org", "Ada Admin", 1, NOW); // an administrator with no event roles
  addUser.run("usr_org_plain", "org@example.org", "Ola Organizer", 0, NOW); // an organizer who is not an administrator
  h.sqlite.prepare("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, ?, 'organizer', ?)").run("usr_org_plain", EVENT, NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setMailTransportForTests(null);
  setHandleForTests(null);
  h.sqlite.close();
});

// --- helpers, in the shape of tests/webhooks.test.ts and tests/password-reset.test.ts ---

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

const nOf = (sql: string, ...params: (string | number)[]) => (h.sqlite.prepare(sql).get(...params) as { n: number }).n;
const one = <T>(sql: string, ...params: (string | number)[]) => h.sqlite.prepare(sql).get(...params) as T;
const auditRows = () => nOf("SELECT count(*) AS n FROM audit_log");

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
const ids = (rows: OutboxView[]) => rows.map((r) => r.id);

/** A member of a team whose kept project is submitted (as in tests/webhooks.test.ts). */
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

/** A judge of evt_01 from the fixture, not an administrator and not the organizer. */
function judge(): Actor {
  const row = one<{ id: string }>(
    "SELECT ur.user_id AS id FROM user_roles ur JOIN users u ON u.id = ur.user_id " +
      "WHERE ur.event_id = ? AND ur.role = 'judge' AND u.is_admin = 0 AND ur.user_id <> 'usr_organizer' LIMIT 1",
    EVENT,
  );
  if (!row) throw new Error("no judge of evt_01 in the fixture");
  return actorIn(row.id);
}

// --- the rows the reads return, inserted with plain SQL ---

type OutboxInsert = {
  id?: string;
  eventId?: string | null;
  kind?: string;
  to?: string;
  subject?: string;
  body?: string;
  status?: string;
  error?: string | null;
  createdBy?: string | null;
  createdAt?: string;
  sentAt?: string | null;
};

let seq = 0;
function insertOutbox(row: OutboxInsert) {
  h.sqlite
    .prepare(
      "INSERT INTO outbox (id, event_id, kind, to_email, subject, body, status, error, created_by, created_at, sent_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id ?? `obx_${String(++seq).padStart(3, "0")}`,
      row.eventId === undefined ? EVENT : row.eventId, // null stays null: a portal row
      row.kind ?? "judge_invite",
      row.to ?? "judge@example.org",
      row.subject ?? "Please judge Sample Hack",
      row.body ?? "The event runs in March.",
      row.status ?? "off",
      row.error ?? null,
      row.createdBy ?? null,
      row.createdAt ?? NOW,
      row.sentAt ?? null,
    );
}

/** Two rows for evt_01, one portal row, one row for another event (the fixture holds only
 *  evt_01, so that event is made here) — the reads must keep the three groups apart. */
function seedOutbox() {
  h.sqlite
    .prepare("INSERT INTO events (id, slug, name, submissions_close_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("evt_02", "another-hack-2026", "Another Hack 2026", "2026-05-01T00:00:00.000Z", NOW);
  insertOutbox({ id: "obx_evt_old", kind: "judge_invite", to: "old.judge@example.org", subject: "Please judge", body: "First ask.", status: "failed", error: "connection refused", createdAt: "2026-09-27T10:00:00.000Z" });
  insertOutbox({ id: "obx_evt_new", kind: "voter_link", to: "voter@example.org", subject: "Your voting link", body: "Vote here.", status: "sent", sentAt: "2026-09-28T09:00:05.000Z", createdAt: "2026-09-28T09:00:00.000Z" });
  insertOutbox({ id: "obx_portal", eventId: null, kind: "admin_setup", to: "founder@example.org", subject: "Set up the portal", body: "Welcome.", status: "off", createdAt: "2026-09-26T08:00:00.000Z" });
  insertOutbox({ id: "obx_other", eventId: "evt_02", kind: "claim_link", to: "someone@example.org", subject: "Claim your project", body: "Here.", status: "sent", sentAt: "2026-09-28T10:00:03.000Z", createdAt: "2026-09-28T10:00:00.000Z" });
  expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(4); // positive control: the seed rows are well-formed
}

// --- the mail module ---

type TransportMessage = { from: string; to: string; subject: string; text: string };
const sentByTransport: TransportMessage[] = [];
const recordingTransport = { sendMail: async (m: TransportMessage) => void sentByTransport.push(m) };
const failingTransport = { sendMail: async () => { throw new Error("SMTP went away"); } };

describe("the mail module", () => {
  it("with SMTP_URL unset or empty the mail is simply off, and no transport is ever called", async () => {
    for (const env of [{}, { SMTP_URL: "" }]) {
      expect(mailProblem(env)).toBeNull();
      expect(mailSettings(env)).toEqual({ on: false });
      sentByTransport.length = 0;
      setMailTransportForTests(recordingTransport);
      const out = await sendMail({ to: "judge@example.org", subject: "Hello", text: "Please judge." }, env);
      expect(out).toEqual({ status: "off" });
      expect(sentByTransport).toHaveLength(0);
    }
  });

  it("a wrong SMTP_URL or a missing or @-less MAIL_FROM is named by mailProblem, and mailSettings refuses to run", () => {
    for (const env of [
      { SMTP_URL: "http://mail.test", MAIL_FROM: "portal@mail.test" },
      { SMTP_URL: "smtps://mail.test:465" }, // MAIL_FROM missing
      { SMTP_URL: "smtp://mail.test:25", MAIL_FROM: "portal.mail.test" }, // no @
    ]) {
      const problem = mailProblem(env);
      if (typeof problem !== "string") throw new Error(`expected mailProblem to name a setting for ${JSON.stringify(env)}`);
      expect(problem).toMatch(/SMTP_URL|MAIL_FROM/);
      expect(() => mailSettings(env)).toThrow(problem);
    }
  });

  it("with the settings on, sendMail hands the transport {from, to, subject, text} and returns an ISO sentAt", async () => {
    expect(mailProblem(ON_ENV)).toBeNull();
    expect(mailSettings(ON_ENV)).toEqual({ on: true, url: "smtp://mail.test:25", from: "portal@mail.test" });
    sentByTransport.length = 0;
    setMailTransportForTests(recordingTransport);
    const before = Date.now();
    const out = await sendMail({ to: "judge@example.org", subject: "You are invited", text: "Please judge Sample Hack." }, ON_ENV);
    const after = Date.now();
    if (out.status !== "sent") throw new Error(`expected sent, got ${out.status}`);
    expect(Date.parse(out.sentAt)).not.toBeNaN();
    expect(Date.parse(out.sentAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(out.sentAt)).toBeLessThanOrEqual(after);
    expect(sentByTransport).toEqual([
      { from: "portal@mail.test", to: "judge@example.org", subject: "You are invited", text: "Please judge Sample Hack." },
    ]);
  });

  it("a transport that rejects is reported as failed with its message, never thrown", async () => {
    setMailTransportForTests(failingTransport);
    const out = await sendMail({ to: "judge@example.org", subject: "Hello", text: "Please judge." }, ON_ENV);
    if (out.status !== "failed") throw new Error(`expected failed, got ${out.status}`);
    expect(out.error).toBe("SMTP went away");
  });

  it("an address without an @, or a to or subject carrying a newline, fails before any transport is called", async () => {
    setMailTransportForTests(recordingTransport);
    sentByTransport.length = 0;
    for (const message of [
      { to: "not-an-address", subject: "Fine", text: "Body" },
      { to: "judge\r@example.org", subject: "Fine", text: "Body" },
      { to: "judge\n@example.org", subject: "Fine", text: "Body" },
      { to: "judge@example.org", subject: "Bad\r\nsubject", text: "Body" },
      { to: "judge@example.org", subject: "Bad\nsubject", text: "Body" },
    ]) {
      const out = await sendMail(message, ON_ENV);
      if (out.status !== "failed") throw new Error(`expected failed for ${JSON.stringify(message.to)} / ${JSON.stringify(message.subject)}`);
      expect(out.error.length).toBeGreaterThan(0);
    }
    expect(sentByTransport).toHaveLength(0);
  });
});

// --- a real SMTP conversation: nodemailer's own transport against a small server in this process ---

type Received = { from: string; to: string[]; data: string };

/** Speaks just enough SMTP for one plain message: greeting, EHLO, MAIL, RCPT, DATA, QUIT. */
async function smtpServer(): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let mail: Received = { from: "", to: [], data: "" };
    socket.write("220 smtp.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(mail);
            socket.write("250 queued\r\n");
          } else mail.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 smtp.test\r\n");
        else if (verb === "MAIL") {
          mail = { from: line, to: [], data: "" };
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          mail.to.push(line);
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 end with a dot\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `smtp://127.0.0.1:${port}`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("sending through SMTP", () => {
  it("nodemailer's real transport hands the server the message from MAIL_FROM to the one address", async () => {
    const smtp = await smtpServer();
    try {
      const out = await sendMail(
        { to: "judge@example.org", subject: "You are invited to judge", text: "Open your console:\nhttp://localhost:8080/judge/sample-hack-2026" },
        { SMTP_URL: smtp.url, MAIL_FROM: "portal@mail.test" },
      );
      expect(out.status).toBe("sent");
      expect(smtp.received).toHaveLength(1);
      const [mail] = smtp.received;
      expect(mail!.from).toContain("<portal@mail.test>");
      expect(mail!.to).toEqual([expect.stringContaining("<judge@example.org>")]);
      expect(mail!.data).toContain("Subject: You are invited to judge");
      expect(mail!.data).toContain("http://localhost:8080/judge/sample-hack-2026");
    } finally {
      await smtp.close();
    }
  });

  it("a server that is not there gives failed with the reason, and nothing is thrown", async () => {
    const smtp = await smtpServer();
    const url = smtp.url;
    await smtp.close(); // the port is free again: the connection is refused
    const out = await sendMail({ to: "judge@example.org", subject: "Hello", text: "Body" }, { SMTP_URL: url, MAIL_FROM: "portal@mail.test" });
    if (out.status !== "failed") throw new Error(`expected failed, got ${out.status}`);
    expect(out.error).toMatch(/ECONNREFUSED|connect/i);
  });
});

// --- the table ---

describe("the outbox table", () => {
  it("accepts a row in each status, the sent one stamped and the failed one explained", () => {
    insertOutbox({ status: "sent", sentAt: NOW });
    insertOutbox({ status: "failed", error: "connection refused" });
    insertOutbox({ status: "off" });
    expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(3);
  });

  it("refuses rows outside the shapes the database itself polices", () => {
    const bad: OutboxInsert[] = [
      { kind: "newsletter" },
      { status: "queued" },
      { to: "not-an-address" },
      { subject: "" },
      { subject: "x".repeat(201) },
      { body: "" },
      { body: "x".repeat(20001) },
      { createdAt: "not-a-date" },
      { status: "sent", sentAt: null }, // sent without a stamp
      { status: "failed", sentAt: NOW }, // a stamp on a row that was not sent
    ];
    for (const row of bad) {
      expect(() => insertOutbox(row), `expected a constraint error for ${JSON.stringify(row)}`).toThrow(/constraint/i);
      expect(nOf("SELECT count(*) AS n FROM outbox")).toBe(0); // nothing leaked in
    }
  });
});

// --- the reads ---

describe("reading the outbox", () => {
  it("refusals come first: no session gets 401, a participant or a judge of the event 403, a mere organizer 403 on the portal's rows", () => {
    const before = auditRows();
    expectHttpError(() => listOutbox(null, EVENT), 401, "unauthenticated");
    expectHttpError(() => listPortalOutbox(null), 401, "unauthenticated");
    expect(auditRows()).toBe(before); // a 401 writes no audit row
    expectHttpError(() => listOutbox(participant(), EVENT), 403, "not_an_organizer");
    expectHttpError(() => listOutbox(judge(), EVENT), 403, "not_an_organizer");
    expectHttpError(() => listPortalOutbox(actorIn("usr_org_plain")), 403, "not_an_admin");
    // Each 403 leaves exactly one refusal row, as the gate shared with the webhooks and the
    // Accounts page does (guardRead in src/server/mutate.ts); the webhook and password-reset
    // tests never assert these counts themselves, so this follows that shared gate.
    expect(auditRows()).toBe(before + 3);
  });

  it("an event's organizer or an administrator sees that event's rows only, newest first, by id or by slug", () => {
    seedOutbox();
    // the fixture names no slug; it is derived from the event's name at import, so read it back
    const slug = one<{ slug: string }>("SELECT slug FROM events WHERE id = ?", EVENT).slug;
    const byId = listOutbox(organizer(), EVENT);
    expect(ids(byId)).toEqual(["obx_evt_new", "obx_evt_old"]); // newest first, and neither the portal row nor evt_02's
    const newest = byId[0]!;
    expect(newest.kind).toBe("voter_link");
    expect(newest.toEmail).toBe("voter@example.org");
    expect(newest.subject).toBe("Your voting link");
    expect(newest.body).toBe("Vote here.");
    expect(newest.status).toBe("sent");
    expect(newest.error).toBeNull();
    expect(newest.sentAt).toBe("2026-09-28T09:00:05.000Z");
    const older = byId[1]!;
    expect(older.status).toBe("failed");
    expect(older.error).toBe("connection refused");
    expect(older.sentAt).toBeNull();
    expect(listOutbox(organizer(), slug)).toEqual(byId); // the slug names the same event
    expect(listOutbox(actorIn("usr_org_plain"), EVENT)).toEqual(byId); // the organizer role alone is enough
    expect(listOutbox(actorIn("usr_admin"), EVENT)).toEqual(byId); // so is being an administrator
  });

  it("the portal's own rows are for administrators alone", () => {
    seedOutbox();
    const rows = listPortalOutbox(actorIn("usr_admin"));
    expect(ids(rows)).toEqual(["obx_portal"]); // the portal row only, never an event's
    expect(rows[0]!.kind).toBe("admin_setup");
    expect(rows[0]!.toEmail).toBe("founder@example.org");
    expect(rows[0]!.status).toBe("off");
    expect(listPortalOutbox(organizer())).toEqual(rows); // usr_organizer is an administrator too
  });

  it("the read gives back at most the newest 100 rows", () => {
    for (let i = 0; i < 101; i++) {
      insertOutbox({ eventId: EVENT, subject: `Cap ${String(i).padStart(3, "0")}`, createdAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000).toISOString() });
    }
    const rows = listOutbox(organizer(), EVENT);
    expect(rows).toHaveLength(100);
    expect(rows[0]!.subject).toBe("Cap 100"); // newest first
    expect(rows.map((r) => r.subject)).not.toContain("Cap 000"); // the oldest fell off the end
  });
});
