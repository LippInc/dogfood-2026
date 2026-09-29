import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorById, addUser, auditRows, count, NOW, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Emailed reminders to judges (lane comms): with SMTP_URL set the Judges page's Not started view can mail the
// reminder its copy button gives, to one judge or to all of them; organizers only; a judge at most once an hour
// (429 with Retry-After, in the audit log); without SMTP_URL the page keeps only its copy buttons.

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
const { remindJudges } = await import("@/server/dal/reminders");
const { setMailTransportForTests } = await import("@/server/mail");
const { setMailWaitForTests } = await import("@/server/dal/mailing");
const { createLoginSession } = await import("@/server/session");
const { resetRateLimits } = await import("@/server/rate-limit");
const { reminderText } = await import("@/lib/judge-reminder");
const { POST } = await import("@/app/api/events/[event]/judges/reminders/route");
const JudgesPage = (await import("@/app/organize/[event]/judges/page")).default;

const ENV_KEYS = ["SMTP_URL", "MAIL_FROM", "PUBLIC_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
type Sent = { to: string; subject: string; text: string };
const sent: Sent[] = [];
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SMTP_URL = "smtp://mail.test:25";
  process.env.MAIL_FROM = "portal@mail.test";
  process.env.PUBLIC_URL = "https://portal.example.org";
  sent.length = 0;
  setMailTransportForTests({ sendMail: async (m: Sent) => void sent.push(m) } as never);
  resetRateLimits();
});
afterEach(() => {
  setMailTransportForTests(null);
  setMailWaitForTests(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A new judge of the Security track (trk_04) with an open review of each of its first n projects, nothing saved. */
function newJudge(id: string, name: string, n: number) {
  addUser(id, `${id}@example.org`, name);
  sqlRun("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, 'evt_01', 'judge', ?)", id, NOW);
  sqlRun("INSERT INTO judge_tracks (judge_user_id, event_id, track_id) VALUES (?, 'evt_01', 'trk_04')", id);
  sqlRun("INSERT OR IGNORE INTO assignment_runs (id, event_id, mode, seed, params, created_at) VALUES ('run_t', 'evt_01', 'topup', 1, '{}', ?)", NOW);
  const projects = sqlAll<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' AND track_id = 'trk_04' ORDER BY id LIMIT ?", n);
  projects.forEach((p, i) =>
    sqlRun("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, status, created_at) VALUES (?, 'evt_01', ?, ?, 'run_t', 'pending', ?)", `asg_${id}_${i}`, id, p.id, NOW),
  );
}
const participant = () => actorById(sqlGet<{ id: string }>("SELECT user_id AS id FROM team_members WHERE event_id = 'evt_01' ORDER BY user_id LIMIT 1")!.id);
const eventName = () => sqlGet<{ name: string }>("SELECT name FROM events WHERE id = 'evt_01'")!.name;

describe("who may email reminders", () => {
  it("401 without a session, 403 audited for a participant and a judge, 200 for the organizer (positive control)", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    await expect(remindJudges(null, "evt_01", { judge: "usr_idle" })).rejects.toMatchObject({ status: 401 });
    const refusals = count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'");
    await expect(remindJudges(participant(), "evt_01", { judge: "usr_idle" })).rejects.toMatchObject({ status: 403, code: "not_an_organizer" });
    await expect(remindJudges(actorById("jdg_01"), "evt_01", { notStarted: true })).rejects.toMatchObject({ status: 403 });
    expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'")).toBe(refusals + 2);
    expect(sent).toHaveLength(0);
    const report = await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    expect(report.mailed).toEqual([{ to: "usr_idle@example.org", status: "sent" }]);
  });

  it("the route: 401, 403 and 200 on the same URL", async () => {
    newJudge("usr_idle", "Ida Idle", 1);
    const call = () =>
      POST(new Request("http://localhost:8080/api/events/evt_01/judges/reminders", { method: "POST", body: JSON.stringify({ judge: "usr_idle" }) }), {
        params: Promise.resolve({ event: "evt_01" }),
      });
    cookie = undefined;
    expect((await call()).status).toBe(401);
    cookie = createLoginSession(h().db, "jdg_01").token;
    expect((await call()).status).toBe(403);
    cookie = createLoginSession(h().db, "usr_organizer").token;
    expect((await call()).status).toBe(200);
    const again = await call();
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(3500);
    cookie = undefined;
  });
});

describe("what is mailed", () => {
  it("the same words the copy button gives, with the judge's console, one audited outbox row each", async () => {
    newJudge("usr_idle", "Ida Idle", 3);
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    const words = reminderText({ name: "Ida Idle", assigned: 3, pending: 3, notStarted: true }, eventName(), "https://portal.example.org/judge/sample-hack-2026");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(`${words}\n`);
    const row = sqlGet<{ kind: string; status: string; body: string }>("SELECT kind, status, body FROM outbox")!;
    expect(row).toMatchObject({ kind: "judge_reminder", status: "sent", body: `${words}\n` });
    expect(auditRows().filter((r) => r.action === "mail.sent").map((r) => (r.after as { kind: string }).kind)).toEqual(["judge_reminder", "judge_reminder"]);
  });

  it("all not started: every judge who has saved nothing, and no one else", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    newJudge("usr_idle2", "Ivo Idle", 1);
    const report = await remindJudges(organizer(), "evt_01", { notStarted: true });
    expect(report.mailed.map((m) => m.to).sort()).toEqual(["usr_idle2@example.org", "usr_idle@example.org"]);
    expect(report.tooSoon).toEqual([]);
  });

  it("a judge with no open review, nobody to start, email off and a published event are refused, and nothing is mailed", async () => {
    await expect(remindJudges(organizer(), "evt_01", { notStarted: true })).rejects.toMatchObject({ status: 409, code: "nothing_to_remind" });
    newJudge("usr_idle", "Ida Idle", 1);
    delete process.env.SMTP_URL;
    await expect(remindJudges(organizer(), "evt_01", { judge: "usr_idle" })).rejects.toMatchObject({ status: 409, code: "email_off" });
    process.env.SMTP_URL = "smtp://mail.test:25";
    sqlRun("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'", NOW);
    await expect(remindJudges(organizer(), "evt_01", { judge: "usr_idle" })).rejects.toMatchObject({ status: 409, code: "results_published" });
    expect(sent).toHaveLength(0);
  });
});

describe("at most once an hour per judge", () => {
  it("a second reminder within the hour is 429 with its wait, written to the audit log; nothing is mailed", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    const err = await remindJudges(organizer(), "evt_01", { judge: "usr_idle" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    expect((err as { retryAfter: number }).retryAfter).toBeGreaterThan(3500);
    expect(auditRows().at(-1)).toMatchObject({ action: "ratelimit.refused", targetId: "judge reminder", after: { judges: ["usr_idle"] } });
    expect(sent).toHaveLength(1);
  });

  it("after the hour it goes again (the rule's positive control)", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    sqlRun("UPDATE outbox SET created_at = ?", new Date(Date.now() - 61 * 60 * 1000).toISOString());
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    expect(sent).toHaveLength(2);
  });

  it("a reminder that did not go out (failed) does not count: the organizer may try again at once", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    setMailTransportForTests({
      sendMail: async () => {
        throw Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
      },
    } as never);
    const first = await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    expect(first.mailed[0]).toMatchObject({ status: "failed" });
    setMailTransportForTests({ sendMail: async (m: Sent) => void sent.push(m) } as never);
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    expect(sent).toHaveLength(1);
  });

  it("in a batch, a judge reminded within the hour is left out and named; every one too soon is 429", async () => {
    newJudge("usr_idle", "Ida Idle", 2);
    newJudge("usr_idle2", "Ivo Idle", 1);
    await remindJudges(organizer(), "evt_01", { judge: "usr_idle" });
    const batch = await remindJudges(organizer(), "evt_01", { notStarted: true });
    expect(batch.mailed.map((m) => m.to)).toEqual(["usr_idle2@example.org"]);
    expect(batch.tooSoon).toMatchObject([{ judge: "usr_idle", name: "Ida Idle" }]);
    await expect(remindJudges(organizer(), "evt_01", { notStarted: true })).rejects.toMatchObject({ status: 429 });
  });
});

describe("the Judges page", () => {
  const draw = async (show?: string) => {
    cookie = createLoginSession(h().db, "usr_organizer").token;
    const page = await JudgesPage({ params: Promise.resolve({ event: "sample-hack-2026" }), searchParams: Promise.resolve(show ? { show } : {}) } as never);
    cookie = undefined;
    const { prelude } = await prerender(page);
    return await new Response(prelude).text();
  };

  it("with SMTP_URL: the Not started view has Email N reminders and Email reminder per judge, beside the copy buttons", async () => {
    newJudge("usr_idle", "Ida Idle", 3);
    newJudge("usr_idle2", "Ivo Idle", 1);
    const html = await draw("not-started");
    expect(html).toContain("Copy 2 reminders");
    expect(html).toContain("Email 2 reminders");
    expect(html).toContain('aria-label="Email reminder to Ida Idle"');
    expect(html).toContain("Copy reminder");
  });

  it("without SMTP_URL: only today's copy buttons", async () => {
    delete process.env.SMTP_URL;
    newJudge("usr_idle", "Ida Idle", 3);
    const html = await draw("not-started");
    expect(html).toContain("Copy 1 reminder");
    expect(html).not.toContain("Email 1 reminder");
    expect(html).not.toContain("Email reminder");
  });
});
