import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorById, addUser, auditRows, count, expectHttpError, NOW, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";
import type { Actor } from "@/server/authz";

// The organizers' updates to an event (lane comms): posting, editing and removing are organizer-only audited
// writes; an edit or a removal keeps the old words in its audit row; the public pages show the newest three as
// plain text; with SMTP_URL set an update can also be mailed to the event's participants; and an update travels
// in the event's fixtures.json export into a new event.

let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/organize/sample-hack-2026/updates",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {} }),
}));

const h = withFixtureEvent();
const { editUpdate, listUpdates, postUpdate, removeUpdate } = await import("@/server/dal/updates");
const { setMailTransportForTests } = await import("@/server/mail");
const { setMailWaitForTests } = await import("@/server/dal/mailing");
const { exportFile } = await import("@/server/dal/exports");
const { importEventFile } = await import("@/server/dal/imports");
const { createLoginSession } = await import("@/server/session");
const { resetRateLimits } = await import("@/server/rate-limit");
const { UpdateEntry, LatestUpdates } = await import("@/components/event-updates");
const UpdatesAdminPage = (await import("@/app/organize/[event]/updates/page")).default;
const routes = await import("@/app/api/events/[event]/updates/route");
const oneRoute = await import("@/app/api/events/[event]/updates/[update]/route");

const ENV_KEYS = ["SMTP_URL", "MAIL_FROM", "PUBLIC_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.SMTP_URL;
  process.env.PUBLIC_URL = "https://portal.example.org";
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

type Sent = { to: string; subject: string; text: string };
const sent: Sent[] = [];
function mailOn() {
  process.env.SMTP_URL = "smtp://mail.test:25";
  process.env.MAIL_FROM = "portal@mail.test";
  sent.length = 0;
  setMailTransportForTests({ sendMail: async (m: Sent) => void sent.push(m) } as never);
}

const participant = (): Actor => actorById(sqlGet<{ id: string }>("SELECT user_id AS id FROM team_members WHERE event_id = 'evt_01' ORDER BY user_id LIMIT 1")!.id);
const admin = (): Actor => ({ ...organizer(), isAdmin: true });
const post = (title = "Deadline extended", body = "Submissions now close at 18:00 UTC.\nGood luck!", email = false) => postUpdate(organizer(), "evt_01", { title, body, email });
const lastAudit = () => auditRows().at(-1)!;

describe("who may post, edit and remove an update", () => {
  it("no session is 401 for every write, and nothing is written", async () => {
    await expect(postUpdate(null, "evt_01", { title: "x", body: "y" })).rejects.toMatchObject({ status: 401 });
    const { update } = await post();
    expectHttpError(() => editUpdate(null, "evt_01", update.id, { title: "x", body: "y" }), 401, "unauthenticated");
    expectHttpError(() => removeUpdate(null, "evt_01", update.id), 401, "unauthenticated");
    expect(count("SELECT count(*) AS n FROM event_updates")).toBe(1);
  });

  it("a participant and a judge are 403, each refusal in the audit log; the organizer (positive control) posts", async () => {
    const before = count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'");
    await expect(postUpdate(participant(), "evt_01", { title: "x", body: "y" })).rejects.toMatchObject({ status: 403, code: "not_an_organizer" });
    await expect(postUpdate(actorById("jdg_01"), "evt_01", { title: "x", body: "y" })).rejects.toMatchObject({ status: 403 });
    const { update } = await post();
    expectHttpError(() => editUpdate(participant(), "evt_01", update.id, { title: "x", body: "y" }), 403, "not_an_organizer");
    expectHttpError(() => removeUpdate(participant(), "evt_01", update.id), 403, "not_an_organizer");
    expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused'")).toBe(before + 4);
    expect(count("SELECT count(*) AS n FROM event_updates")).toBe(1);
  });

  it("an administrator who does not organize the event reads it but may not post (runsEvent)", async () => {
    addUser("usr_adm", "adm@example.org", "Ada Admin");
    sqlRun("UPDATE users SET is_admin = 1 WHERE id = 'usr_adm'");
    await expect(postUpdate({ ...actorById("usr_adm"), isAdmin: true }, "evt_01", { title: "x", body: "y" })).rejects.toMatchObject({ status: 403 });
  });

  it("the routes answer 401, 403 and 201 on the same URL, and anyone reads the list", async () => {
    const call = () =>
      routes.POST(new Request("http://localhost:8080/api/events/evt_01/updates", { method: "POST", body: JSON.stringify({ title: "Judging has started", body: "Judges are at work." }) }), {
        params: Promise.resolve({ event: "evt_01" }),
      });
    cookie = undefined;
    expect((await call()).status).toBe(401);
    cookie = createLoginSession(h().db, participant().userId).token;
    expect((await call()).status).toBe(403);
    cookie = createLoginSession(h().db, "usr_organizer").token;
    const ok = await call();
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { update: { id: string } }).update.id;
    cookie = undefined;
    const list = await routes.GET(new Request("http://localhost:8080/api/events/evt_01/updates"), { params: Promise.resolve({ event: "evt_01" }) });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { total: number }).total).toBe(1);
    const del = () => oneRoute.DELETE(new Request(`http://localhost:8080/api/events/evt_01/updates/${id}`, { method: "DELETE" }), { params: Promise.resolve({ event: "evt_01", update: id }) });
    expect((await del()).status).toBe(401);
    cookie = createLoginSession(h().db, "usr_organizer").token;
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(404);
    cookie = undefined;
  });

  it("allowed after publishing: updates are news, not results", async () => {
    sqlRun("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'", NOW);
    const { update } = await post("Winners announced", "See the results page.");
    expect(editUpdate(organizer(), "evt_01", update.id, { title: "Winners announced", body: "See the results." }).body).toBe("See the results.");
    expect(removeUpdate(organizer(), "evt_01", update.id)).toEqual({ removed: update.id });
  });

  it("a title or body that is empty or too long is a 422 with the field named", async () => {
    await expect(postUpdate(organizer(), "evt_01", { title: "  ", body: "words" })).rejects.toMatchObject({ status: 422, details: { title: expect.any(Array) } });
    await expect(postUpdate(organizer(), "evt_01", { title: "t", body: "x".repeat(5001) })).rejects.toMatchObject({ status: 422, details: { body: expect.any(Array) } });
  });
});

describe("the audit rows", () => {
  it("post, edit and remove each write one row; the edit and the removal keep the old words", async () => {
    const { update } = await post("Deadline extended", "Now 18:00.");
    expect(lastAudit()).toMatchObject({ action: "update.post", targetId: update.id, after: { title: "Deadline extended", body: "Now 18:00." } });
    editUpdate(organizer(), "evt_01", update.id, { title: "Deadline extended again", body: "Now 20:00." });
    expect(lastAudit()).toMatchObject({
      action: "update.edit",
      targetId: update.id,
      before: { title: "Deadline extended", body: "Now 18:00." },
      after: { title: "Deadline extended again", body: "Now 20:00." },
    });
    const rows = count("SELECT count(*) AS n FROM audit_log");
    // the same words again change nothing and write nothing
    editUpdate(organizer(), "evt_01", update.id, { title: "Deadline extended again", body: "Now 20:00." });
    expect(count("SELECT count(*) AS n FROM audit_log")).toBe(rows);
    removeUpdate(organizer(), "evt_01", update.id);
    expect(lastAudit()).toMatchObject({ action: "update.remove", targetId: update.id, before: { title: "Deadline extended again", body: "Now 20:00." } });
    expect(count("SELECT count(*) AS n FROM event_updates")).toBe(0);
  });

  it("an edited update shows when it was edited", async () => {
    const { update } = await post();
    editUpdate(organizer(), "evt_01", update.id, { title: "Changed", body: "Changed words" });
    expect(listUpdates("evt_01").updates[0]).toMatchObject({ title: "Changed", editedAt: expect.any(String) });
  });
});

describe("the public list", () => {
  it("newest first; the pages take the newest 3 and the total; the full list has every one", async () => {
    for (let i = 1; i <= 5; i++) {
      await post(`Update ${i}`, `Words ${i}`);
      sqlRun("UPDATE event_updates SET created_at = ? WHERE title = ?", `2026-09-2${i}T10:00:00.000Z`, `Update ${i}`);
    }
    const top = listUpdates("evt_01", 3);
    expect(top.total).toBe(5);
    expect(top.updates.map((u) => u.title)).toEqual(["Update 5", "Update 4", "Update 3"]);
    expect(listUpdates("sample-hack-2026").updates.map((u) => u.title)).toEqual(["Update 5", "Update 4", "Update 3", "Update 2", "Update 1"]);
    const html = renderToStaticMarkup(LatestUpdates({ slug: "sample-hack-2026", ...top })!);
    expect(html).toContain("Every update (5)");
    expect(html).toContain('href="/events/sample-hack-2026/updates"');
  });

  it("with no update nothing is drawn at all (the page is as it was)", () => {
    expect(LatestUpdates({ slug: "sample-hack-2026", ...listUpdates("evt_01", 3) })).toBeNull();
  });

  it("plain text: a planted <script> and a link show as text, and line breaks are kept", async () => {
    await post("<b>Bold?</b>", 'Hi<script>alert("x")</script>\nsee <a href="https://evil.example">here</a>');
    const u = listUpdates("evt_01").updates[0]!;
    expect(u.body).toContain("<script>"); // stored and served as the organizer wrote it
    const html = renderToStaticMarkup(UpdateEntry({ u }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<a href=\"https://evil");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain('\nsee &lt;a href=&quot;https://evil.example&quot;&gt;');
  });
});

describe("mailing an update", () => {
  const participants = () => sqlAll<{ email: string }>("SELECT DISTINCT u.email FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.event_id = 'evt_01' ORDER BY u.email").map((r) => r.email);

  it("with SMTP_URL set and the box ticked: every participant once, each recorded in the outbox with the updates link", async () => {
    mailOn();
    const { update, mail } = await post("Winners at 18:00", "In the main hall.", true);
    const to = participants();
    expect(to.length).toBeGreaterThan(1);
    expect(mail).toMatchObject({ on: true });
    expect(mail!.mailed.map((m) => m.status)).toEqual(to.map(() => "sent"));
    expect(sent.map((m) => m.to).sort()).toEqual(to);
    expect(sent[0]!.subject).toBe("Sample Hackathon 2026: Winners at 18:00".replace("Sample Hackathon 2026", sqlGet<{ name: string }>("SELECT name FROM events WHERE id = 'evt_01'")!.name));
    expect(sent[0]!.text).toContain("In the main hall.");
    expect(sent[0]!.text).toContain("https://portal.example.org/events/sample-hack-2026/updates");
    const rows = sqlAll<{ kind: string; status: string; body: string }>("SELECT kind, status, body FROM outbox WHERE kind = 'event_update'");
    expect(rows).toHaveLength(to.length);
    expect(rows.every((r) => r.status === "sent" && r.body.includes("/events/sample-hack-2026/updates"))).toBe(true);
    expect(auditRows().find((r) => r.action === "update.post")).toMatchObject({ targetId: update.id, after: { email: true } });
  });

  it("a failed address is reported with its reason; the rest go out", async () => {
    mailOn();
    const bad = participants()[0]!;
    setMailTransportForTests({
      sendMail: async (m: Sent) => {
        if (m.to === bad) throw Object.assign(new Error("mailbox unavailable"), { responseCode: 550 });
        sent.push(m);
      },
    } as never);
    const { mail } = await post("t", "b", true);
    expect(mail!.mailed.find((m) => m.to === bad)).toMatchObject({ status: "failed" });
    expect(mail!.mailed.filter((m) => m.status === "sent")).toHaveLength(participants().length - 1);
  });

  it("the box unticked mails nothing (positive control)", async () => {
    mailOn();
    const { mail } = await post("t", "b", false);
    expect(mail).toBeNull();
    expect(sent).toHaveLength(0);
    expect(count("SELECT count(*) AS n FROM outbox")).toBe(0);
  });

  it("without SMTP_URL: nothing is sent or recorded, and the answer says email is off", async () => {
    const { mail } = await post("t", "b", true);
    expect(mail).toEqual({ on: false, mailed: [] });
    expect(count("SELECT count(*) AS n FROM outbox")).toBe(0);
  });

  const draw = async () => {
    cookie = createLoginSession(h().db, "usr_organizer").token;
    const page = await UpdatesAdminPage({ params: Promise.resolve({ event: "sample-hack-2026" }) } as never);
    cookie = undefined;
    const { prelude } = await prerender(page);
    return await new Response(prelude).text();
  };

  it("the organizer's page: without SMTP_URL no checkbox and one line that email is off; with it, the checkbox with the count", async () => {
    const off = await draw();
    expect(off).not.toContain('name="email"');
    expect(off).toContain("Email is off on this portal (SMTP_URL is not set)");
    mailOn();
    const on = await draw();
    expect(on).toMatch(/<input type="checkbox"[^>]*name="email"/);
    expect(on).not.toMatch(/name="email"[^>]*checked/);
    expect(on).toContain(`Also mail it to the <!-- -->${participants().length} participants`);
  });
});

describe("export and import", () => {
  it("an event with no update exports no updates key (the file is as before)", () => {
    expect(JSON.parse(exportFile(organizer(), "evt_01", "fixtures.json").body)).not.toHaveProperty("updates");
  });

  it("the updates travel in fixtures.json into a new event, edits and times kept", async () => {
    const { update } = await post("First", "One\ntwo");
    editUpdate(organizer(), "evt_01", update.id, { title: "First, edited", body: "One\ntwo\nthree" });
    await post("Second", "More");
    const file = JSON.parse(exportFile(organizer(), "evt_01", "fixtures.json").body);
    expect(file.updates).toHaveLength(2);
    expect(file.updates[0]).toMatchObject({ title: "First, edited", body: "One\ntwo\nthree", edited_at: expect.any(String) });
    const before = listUpdates("evt_01").updates;
    file.event = { ...file.event, id: "evt_copy", name: "Copy of the event" };
    const report = importEventFile(admin(), file);
    const copied = listUpdates("evt_copy").updates;
    expect(copied.map((u) => [u.title, u.body, u.at, u.editedAt])).toEqual(before.map((u) => [u.title, u.body, u.at, u.editedAt]));
    expect(report).toBeTruthy();
  });

  it("into the event that is here already, a file with an update the event lacks is refused whole (409 new_event_only)", async () => {
    await post("Kept", "here");
    const file = JSON.parse(exportFile(organizer(), "evt_01", "fixtures.json").body);
    // the same file again: every update is present, so it is not refused for them
    file.updates.push({ id: "upd_planted", title: "Planted", body: "not posted here", at: NOW });
    expect(() => importEventFile(admin(), file)).toThrowError(/would add 1 update to it/);
    expect(count("SELECT count(*) AS n FROM event_updates WHERE id = 'upd_planted'")).toBe(0);
  });
});

describe("the sentence after mailing an update", () => {
  it("all sent, one reason for all failed, and a mix each read plainly", async () => {
    const { mailedNote } = await import("@/lib/mail-note");
    expect(mailedNote({ on: false, mailed: [] }, "participant")).toBe("Nothing was mailed: email is off.");
    expect(mailedNote({ on: true, mailed: [{ to: "a@x.org", status: "sent" }, { to: "b@x.org", status: "sent" }] }, "participant")).toBe("Mailed to all 2 participants.");
    const dead = { on: true, mailed: [{ to: "a@x.org", status: "failed" as const, error: "connect ECONNREFUSED" }, { to: "b@x.org", status: "failed" as const, error: "not tried: connect ECONNREFUSED" }] };
    expect(mailedNote(dead, "participant")).toBe("Could not mail any of the 2 (connect ECONNREFUSED).");
    const mixed = { on: true, mailed: [{ to: "a@x.org", status: "sent" as const }, { to: "b@x.org", status: "failed" as const, error: "mailbox unavailable" }] };
    expect(mailedNote(mixed, "participant")).toBe("Mailed 1 of 2. Could not mail b@x.org (mailbox unavailable).");
  });
});
