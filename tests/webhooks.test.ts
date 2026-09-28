import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles, webhookDeliveries } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { hideComment, postComment } from "@/server/dal/comments";
import { castBallot, enterVoting, makeVotingLink, saveVotingSettings, type Client } from "@/server/dal/voting";
import { getPairwiseState, pickPairwise, setJudgingMode, undoPairwise } from "@/server/dal/pairwise";
import { saveReview } from "@/server/dal/reviews";
import {
  createWebhook,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  rotateWebhookSecret,
  setWebhookEnabled,
  testWebhook,
} from "@/server/dal/webhooks";
import { CLAIM_MS, MAX_ATTEMPTS, RETRY_DELAYS_S, deliverDue, privateAddress, verifySignature } from "@/server/webhooks";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

// --- the receiver: a local HTTP server the deliveries are POSTed to ---

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
const statuses: number[] = []; // each request is answered with the next status; 200 when empty

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.statusCode = statuses.shift() ?? 200;
    res.end("ok");
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const receiverUrl = () => `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/hook`;

// --- the stub: an in-process fetch, so no test but the end-to-end one waits on the network ---
// It records what deliverDue sends into the same `received` array the real receiver fills
// (headers with lowercased names, as req.headers would give them) and answers from the same
// `statuses` queue, so every existing read and push keeps working unchanged.

const stubFetch: typeof fetch = async (input, init) => {
  const headers: Record<string, string> = {};
  const given = init?.headers;
  if (given instanceof Headers) given.forEach((value, name) => (headers[name.toLowerCase()] = value));
  else if (Array.isArray(given)) for (const [name, value] of given) headers[name.toLowerCase()] = String(value);
  else if (given) for (const [name, value] of Object.entries(given)) headers[name.toLowerCase()] = String(value);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === "string" ? init.body : "";
  received.push({ method: init?.method ?? "GET", url, headers, body });
  return new Response(null, { status: statuses.shift() ?? 200 });
};

// --- the database, fresh per test, and the private-target flag clean per test ---

let savedAllowPrivate: string | undefined;

beforeEach(() => {
  resetRateLimits();
  savedAllowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE;
  delete process.env.WEBHOOKS_ALLOW_PRIVATE;
  received.length = 0;
  statuses.length = 0;
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the webhook DAL and deliverDue go through getDb()
});

afterEach(() => {
  if (savedAllowPrivate === undefined) delete process.env.WEBHOOKS_ALLOW_PRIVATE;
  else process.env.WEBHOOKS_ALLOW_PRIVATE = savedAllowPrivate;
  setHandleForTests(null);
  h.sqlite.close();
});

// --- helpers, in the shape of tests/records.test.ts and tests/voting.test.ts ---

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

async function expectHttpErrorAsync(call: () => Promise<unknown>, status: number, code: string) {
  let caught: unknown;
  try {
    await call();
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
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

function actorIn(hx: Handle, userId: string): Actor {
  const u = hx.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = hx.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const actorById = (userId: string) => actorIn(h, userId);
const organizer = () => actorById("usr_organizer");

/** A member of a team whose kept project is submitted (as in tests/records.test.ts). */
function anyParticipant() {
  const row = one<{ id: string }>(
    "SELECT tm.user_id AS id FROM team_members tm " +
      "JOIN projects p ON p.team_id = tm.team_id " +
      "WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = 'evt_01' LIMIT 1",
  );
  if (!row) throw new Error("no participant on a submitted team in the fixture");
  return row;
}
const participant = () => actorById(anyParticipant().id);

const CLIENT: Client = { ip: "10.0.0.5", agent: "VoterBrowser" };

const openVoting = () =>
  saveVotingSettings(organizer(), "evt_01", {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
  });

let ipSeq = 0;
const nextIp = () => `10.42.0.${++ipSeq}`;

/** A fresh open-link voter: rotates the link, enters from a fresh network address. */
function linkToken(): string {
  const { code } = makeVotingLink(organizer(), "evt_01");
  return enterVoting(code, { ip: nextIp(), agent: "Agent" }).token;
}

/** Deliveries are queued at the real current time (the audit row's `at`), and
 *  retryDelivery stamps next_attempt_at with the real clock too — so every pass
 *  runs at a `now` safely ahead of Date.now(). */
const soon = (aheadMs = 60_000) => new Date(Date.now() + aheadMs);

const allDeliveries = () => h.db.select().from(webhookDeliveries).all();
const theDelivery = () => {
  const rows = allDeliveries();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const rowById = (id: string) => {
  const row = h.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get();
  if (!row) throw new Error(`no delivery row for ${id}`);
  return row;
};

/** Attempt `firstAttempt`..MAX_ATTEMPTS of one delivery, each pass one step past
 *  the previous backoff, every answer 500. Assumes attempt firstAttempt-1 already
 *  ran at `from`. Returns the time of the last pass. */
async function failFrom(firstAttempt: number, from: Date): Promise<Date> {
  let t = from;
  for (let attempt = firstAttempt; attempt <= MAX_ATTEMPTS; attempt++) {
    t = new Date(t.getTime() + (RETRY_DELAYS_S[attempt - 2]! + 1) * 1000);
    statuses.push(500);
    const out = await deliverDue({ now: t, fetchImpl: stubFetch });
    expect(out.attempted, `attempt ${attempt}`).toBe(1);
  }
  return t;
}

describe("webhooks", () => {
  it("refusals come first: a participant gets 403 whatever the body, no session gets 401", async () => {
    await expectHttpErrorAsync(() => createWebhook(participant(), "evt_01", { url: "nope" }), 403, "not_an_organizer");
    await expectHttpErrorAsync(() => createWebhook(null, "evt_01", { url: receiverUrl(), actions: ["*"] }), 401, "unauthenticated");
    expect(nOf("SELECT count(*) AS n FROM webhooks")).toBe(0);
  });

  it("with WEBHOOKS_ALLOW_PRIVATE unset, organizer URLs that are not http(s) or point at private machinery are 422", async () => {
    for (const url of [
      "nope",
      "ftp://example.org/x",
      "http://localhost:9/x",
      "http://127.0.0.1:9/x",
      "http://169.254.169.254/latest",
      "http://10.1.2.3/x",
    ]) {
      await expectHttpErrorAsync(() => createWebhook(organizer(), "evt_01", { url, actions: ["*"] }), 422, "invalid");
    }
    expect(nOf("SELECT count(*) AS n FROM webhooks")).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("privateAddress: loopback, private, link-local, CGNAT, unspecified (and their v6 forms) are private", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["172.32.0.1", "8.8.8.8", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(privateAddress(ip), ip).toBe(false);
    }
  });

  it("an audited change queues one delivery per subscribed hook, in the same transaction, and secrets never reach the audit log", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const hook = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    expect(hook.id).toMatch(/^whk_/);
    expect(hook.secret).toMatch(/^whsec_/);

    const creates = auditRows().filter((r) => r.action === "webhook.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.targetId).toBe(hook.id);
    expect(JSON.stringify(auditRows())).not.toContain(hook.secret);

    const { id: commentId } = postComment(participant(), "prj_01", { body: "First!" });
    expect(received).toHaveLength(0); // queueing is not sending: no worker runs here

    const rows = allDeliveries();
    expect(rows).toHaveLength(1);
    const d = rows[0]!;
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(0);
    expect(d.action).toBe("comment.post");
    expect(d.webhookId).toBe(hook.id);
    const cast = auditRows().find((r) => r.id === d.auditId)!;
    expect(cast.action).toBe("comment.post");
    const payload = d.payload as { data: { hash: string } };
    expect(payload.data.hash).toBe(cast.hash);

    hideComment(organizer(), commentId, { reason: "Off topic" });
    expect(auditRows().filter((r) => r.action === "comment.hide")).toHaveLength(1); // the change did happen
    expect(nOf("SELECT count(*) AS n FROM webhook_deliveries")).toBe(1); // ...but the hook does not subscribe to it
  });

  it("deliverDue sends the delivery: right method, headers and body, signed verifiably", { timeout: 30_000 }, async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const hook = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Deliver me" });

    const now = soon();
    const out = await deliverDue({ now });
    expect(out).toEqual({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });

    expect(received).toHaveLength(1);
    const req = received[0]!;
    const row = theDelivery();
    expect(req.method).toBe("POST");
    expect(req.headers["dogfood-event"]).toBe("comment.post");
    expect(req.headers["dogfood-delivery"]).toBe(row.id);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify(row.payload));

    const sig = req.headers["dogfood-signature"];
    expect(typeof sig).toBe("string");
    expect(verifySignature(hook.secret, req.body, sig as string, now.getTime())).toBe(true);
    expect(verifySignature("whsec_not_the_secret", req.body, sig as string, now.getTime())).toBe(false);
    const tampered = req.body.slice(0, -1) + (req.body.endsWith("}") ? "]" : "}");
    expect(verifySignature(hook.secret, tampered, sig as string, now.getTime())).toBe(false);
    expect(verifySignature(hook.secret, req.body, sig as string, now.getTime() + 10 * 60 * 1000)).toBe(false);

    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(1);
    expect(row.responseStatus).toBe(200);
    expect(row.deliveredAt).toBe(now.toISOString());
    expect(row.nextAttemptAt).toBeNull();
    expect(row.error).toBeNull();
  });

  it("a 500 is retried with backoff, and after MAX_ATTEMPTS the delivery is final", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Retry me" });

    const t0 = soon();
    statuses.push(500);
    let out = await deliverDue({ now: t0, fetchImpl: stubFetch });
    expect(out).toEqual({ attempted: 1, delivered: 0, retrying: 1, failed: 0 });
    let row = theDelivery();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(new Date(t0.getTime() + RETRY_DELAYS_S[0]! * 1000).toISOString());
    expect(row.error).toBe("answered 500");
    expect(row.responseStatus).toBe(500);
    expect(received).toHaveLength(1);

    // not due yet: a pass at the same moment attempts nothing
    out = await deliverDue({ now: t0, fetchImpl: stubFetch });
    expect(out.attempted).toBe(0);
    expect(received).toHaveLength(1);

    // advance past each delay, always failing
    let t = t0;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      t = new Date(t.getTime() + (RETRY_DELAYS_S[attempt - 2]! + 1) * 1000);
      statuses.push(500);
      const pass = await deliverDue({ now: t, fetchImpl: stubFetch });
      expect(pass.attempted, `attempt ${attempt}`).toBe(1);
      row = theDelivery();
      expect(row.attempts).toBe(attempt);
      expect(row.status).toBe(attempt === MAX_ATTEMPTS ? "failed" : "pending");
      expect(row.error).toBe("answered 500");
    }
    expect(row.nextAttemptAt).toBeNull();

    // final means final: one more pass attempts nothing
    statuses.push(500); // would be consumed if a seventh attempt were made
    const idle = await deliverDue({ now: new Date(t.getTime() + 3_600_000), fetchImpl: stubFetch });
    expect(idle.attempted).toBe(0);
    expect(received).toHaveLength(MAX_ATTEMPTS);
  });

  it("two delivery passes at once (two portal processes on one database) send a due delivery once", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Only once" });

    const t0 = soon();
    const [a, b] = await Promise.all([deliverDue({ now: t0, fetchImpl: stubFetch }), deliverDue({ now: t0, fetchImpl: stubFetch })]);
    expect(received).toHaveLength(1);
    expect(a.attempted + b.attempted).toBe(1);
    expect(theDelivery().status).toBe("delivered");
  });

  it("a pass that dies mid-send keeps the delivery claimed for CLAIM_MS, then it goes out (at least once, never lost)", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Sent once the claim runs out" });

    const t0 = soon();
    // claims the delivery, then never finishes, like a process that died while sending
    void deliverDue({ now: t0, fetchImpl: () => new Promise<Response>(() => {}) });
    expect((await deliverDue({ now: new Date(t0.getTime() + CLAIM_MS - 1000), fetchImpl: stubFetch })).attempted).toBe(0);
    const out = await deliverDue({ now: new Date(t0.getTime() + CLAIM_MS + 1000), fetchImpl: stubFetch });
    expect(out).toEqual({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(received).toHaveLength(1);
  });

  it("a failed delivery can be retried by hand; a delivered one cannot", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const hook = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Fail, then try again" });

    const t0 = soon();
    statuses.push(500);
    await deliverDue({ now: t0, fetchImpl: stubFetch });
    await failFrom(2, t0);
    let row = theDelivery();
    expect(row.status).toBe("failed");

    retryDelivery(organizer(), "evt_01", hook.id, row.id);
    row = theDelivery(); // webhook.redeliver is not subscribed: still exactly this one row
    expect(row.status).toBe("pending");
    expect(row.nextAttemptAt).toBeTruthy();

    const out = await deliverDue({ now: soon(), fetchImpl: stubFetch }); // statuses is empty: the stub answers 200 again
    expect(out).toEqual({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });
    row = theDelivery();
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(MAX_ATTEMPTS + 1);
    expect(row.error).toBeNull();

    expectHttpError(() => retryDelivery(organizer(), "evt_01", hook.id, row.id), 422, "invalid");
  });

  it("a sealed ballot goes out with its picks hidden", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["vote.cast"] });
    openVoting();
    castBallot(null, "evt_01", linkToken(), { projectIds: ["prj_07"] }, CLIENT);

    const rows = allDeliveries();
    expect(rows).toHaveLength(1); // voting.settings, the link and the join are not subscribed
    const d = rows[0]!;
    expect(d.action).toBe("vote.cast");
    const cast = auditRows().find((r) => r.id === d.auditId)!;
    expect((cast.after as { picks: string[] }).picks).toContain("prj_07"); // positive control: the log itself holds the pick
    const payload = d.payload as { data: { before: unknown; after: unknown } };
    expect(payload.data.before).toBeNull();
    expect(payload.data.after).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("prj_07");
  });

  it("a judge's scores go out without the values: who scored which project, and when", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["review.save", "review.submit", "review.amend"] });
    // every fixture review is finished: clear one score (a draft), give it back (finished), change it
    const a = one<{ id: string; judge: string; project: string }>(
      "SELECT id, judge_user_id AS judge, project_id AS project FROM assignments WHERE event_id = 'evt_01' AND status = 'done' ORDER BY id LIMIT 1",
    );
    const c = one<{ key: string; min: number; max: number }>(
      "SELECT key, scale_min AS min, scale_max AS max FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY key LIMIT 1",
    );
    const judge = actorById(a.judge);
    saveReview(judge, a.id, { values: { [c.key]: null } });
    saveReview(judge, a.id, { values: { [c.key]: c.max } });
    saveReview(judge, a.id, { values: { [c.key]: c.min } });

    const rows = allDeliveries();
    expect(rows.map((d) => d.action)).toEqual(["review.save", "review.submit", "review.amend"]);
    const logged = rows.map((d) => auditRows().find((r) => r.id === d.auditId)!);
    // positive control: the log itself holds every value
    expect(typeof (logged[0]!.before as Record<string, unknown>)[c.key]).toBe("number");
    expect(logged[1]!.after).toMatchObject({ [c.key]: c.max, total: expect.any(Number) });
    expect(logged[2]!.before).toMatchObject({ [c.key]: c.max });
    expect(logged[2]!.after).toMatchObject({ [c.key]: c.min });
    for (const d of rows) {
      const data = (d.payload as { data: { target: { id: unknown }; before: unknown; after: unknown } }).data;
      expect(data.target.id).toBe(a.id);
      expect(data.before).toBeNull();
      expect(data.after).toEqual({ project: a.project });
    }
  });

  it("a judge's pairwise answers go out with the track only: not the answer, not the projects", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["pairwise.pick", "pairwise.undo"] });
    setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judges = h.sqlite.prepare("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").all() as {
      id: string;
    }[];
    const judge = judges.map((j) => actorById(j.id)).find((j) => getPairwiseState(j, "evt_01").tracks.some((t) => t.current))!;
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    const q = { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id };
    pickPairwise(judge, "evt_01", { ...q, outcome: "left" });
    undoPairwise(judge, "evt_01", { trackId: q.trackId });

    const rows = allDeliveries();
    expect(rows.map((d) => d.action)).toEqual(["pairwise.pick", "pairwise.undo"]);
    const [pick, undo] = rows.map((d) => ({ d, logged: auditRows().find((r) => r.id === d.auditId)! }));
    // positive control: the log itself holds the answer and the projects
    expect(pick!.logged.after).toMatchObject({ ...q, outcome: "left" });
    expect(undo!.logged.before).toMatchObject({ ...q, outcome: "left" });
    type Data = { target: { id: unknown }; before: unknown; after: unknown };
    const [p, u] = [pick!, undo!].map(({ d }) => (d.payload as { data: Data }).data);
    expect(p!.after).toEqual({ trackId: q.trackId });
    expect(p!.before).toBeNull();
    expect(u!.before).toEqual({ trackId: q.trackId });
    expect(u!.after).toBeNull();
    for (const data of [p!, u!]) {
      expect(data.target.id).toBeNull();
      expect(JSON.stringify(data)).not.toContain(q.left);
      expect(JSON.stringify(data)).not.toContain(q.right);
    }
  });

  it("a test goes only to the webhook it names; a disabled hook hears nothing", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const a = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["*"] });
    const b = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["*"] });
    // creations are audited too, and both hooks subscribe to "*": a heard both creations, b only its own
    expect(nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", a.id)).toBe(2);
    expect(nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", b.id)).toBe(1);

    expect(testWebhook(organizer(), "evt_01", a.id)).toEqual({ id: a.id });
    const tests = allDeliveries().filter((r) => r.action === "webhook.test");
    expect(tests).toHaveLength(1);
    expect(tests[0]!.webhookId).toBe(a.id);

    setWebhookEnabled(organizer(), "evt_01", a.id, false);
    expectHttpError(() => testWebhook(organizer(), "evt_01", a.id), 422, "invalid");
    // the disable itself is audited; only still-enabled hooks hear it
    expect(nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", b.id)).toBe(2);

    postComment(participant(), "prj_01", { body: "Only b should hear this" });
    const comments = allDeliveries().filter((r) => r.action === "comment.post");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.webhookId).toBe(b.id);
    expect(nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ?", a.id)).toBe(3); // unchanged by the comment
  });

  it("rotateWebhookSecret: the next delivery signs with the new secret and not the old", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const hook = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "After rotation" });

    const rotated = rotateWebhookSecret(organizer(), "evt_01", hook.id);
    expect(rotated.id).toBe(hook.id);
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(hook.secret);

    const now = soon();
    await deliverDue({ now, fetchImpl: stubFetch });
    const req = received[0]!;
    const sig = req.headers["dogfood-signature"] as string;
    expect(verifySignature(rotated.secret, req.body, sig, now.getTime())).toBe(true);
    expect(verifySignature(hook.secret, req.body, sig, now.getTime())).toBe(false);
  });

  it("a target that becomes disallowed is not called; the row waits with a 'not sent:' error", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    postComment(participant(), "prj_01", { body: "Now disallowed" });

    process.env.WEBHOOKS_ALLOW_PRIVATE = "false";
    const now = soon();
    const out = await deliverDue({ now, fetchImpl: stubFetch });
    expect(out).toEqual({ attempted: 1, delivered: 0, retrying: 1, failed: 0 });
    expect(received).toHaveLength(0);

    const row = theDelivery();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.error).toMatch(/^not sent: /);
    expect(row.nextAttemptAt).toBe(new Date(now.getTime() + RETRY_DELAYS_S[0]! * 1000).toISOString());
  });

  it("listWebhooks counts match the rows by status, listDeliveries is newest first, and the audit chain still verifies", async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE = "true";
    const hook = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["comment.post"] });
    const other = await createWebhook(organizer(), "evt_01", { url: receiverUrl(), actions: ["vote.cast"] });
    for (const body of ["one", "two", "three"]) postComment(participant(), "prj_01", { body });
    const ids = allDeliveries().map((r) => r.id);
    expect(ids).toHaveLength(3);

    // space the rows out so both due order and "newest first" are unambiguous even within one millisecond
    const base = Date.now();
    ids.forEach((id, i) => {
      const at = new Date(base + (i + 1) * 2_000).toISOString();
      h.sqlite.prepare("UPDATE webhook_deliveries SET created_at = ?, next_attempt_at = ? WHERE id = ?").run(at, at, id);
    });

    const t1 = new Date(base + 10_000);
    statuses.push(200, 500, 500); // oldest arrives, the other two fail and stay pending
    await deliverDue({ now: t1, fetchImpl: stubFetch });
    expect(rowById(ids[0]!).status).toBe("delivered");
    expect(rowById(ids[1]!).status).toBe("pending");
    expect(rowById(ids[2]!).status).toBe("pending");

    h.sqlite.prepare("UPDATE webhook_deliveries SET next_attempt_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(ids[2]!);
    await failFrom(2, t1); // only ids[1] is due from here on
    expect(rowById(ids[1]!).status).toBe("failed");

    setWebhookEnabled(organizer(), "evt_01", other.id, false); // neither hook subscribes to webhook.disable

    const listed = listWebhooks(organizer(), "evt_01").webhooks;
    expect(listed).toHaveLength(2);
    const byId = new Map(listed.map((w) => [w.id, w]));
    expect(byId.get(hook.id)!.enabled).toBe(true);
    expect(byId.get(other.id)!.enabled).toBe(false);
    for (const w of listed) {
      expect(w.counts).toEqual({
        pending: nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'", w.id),
        delivered: nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'delivered'", w.id),
        failed: nOf("SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ? AND status = 'failed'", w.id),
      });
    }
    expect(byId.get(hook.id)!.counts).toEqual({ pending: 1, delivered: 1, failed: 1 });
    expect(byId.get(other.id)!.counts).toEqual({ pending: 0, delivered: 0, failed: 0 });

    expect(listDeliveries(organizer(), "evt_01", hook.id).map((d) => d.id)).toEqual([ids[2], ids[1], ids[0]]);

    expect(verifyAuditChain(h.db).ok).toBe(true);
  });
});
