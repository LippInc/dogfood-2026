import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, useHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { hideComment, listComments, postComment } from "@/server/dal/comments";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  useHandleForTests(h); // the comments DAL goes through getDb()
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

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
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

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
    .run(id, email, name, NOW);
  return actorById(id);
}

const org = () => actorById("usr_organizer");
const participant = () => actorById(userIdByEmail("member1_1@example.org"));

describe("postComment", () => {
  it("refuses a missing session with 401 and writes no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => postComment(null, "prj_01", { body: "Nice" }), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
  });

  it("stores a signed-in user's comment with one comment.post audit row, and lists it with authorship", () => {
    const author = addUser("usr_talker", "talker@example.org", "Talker");
    const { id } = postComment(author, "prj_01", { body: "Nice work" });
    expect(h.sqlite.prepare("SELECT body AS b, user_id AS u FROM comments WHERE id = ?").get(id)).toEqual({
      b: "Nice work",
      u: author.userId,
    });

    const posts = auditRows().filter((r) => r.action === "comment.post");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.actorUserId).toBe(author.userId);
    expect((posts[0]!.after as { chars: number }).chars).toBe(9);

    const shown = listComments(null, "prj_01").find((c) => c.id === id);
    expect(shown?.author).toBe("Talker");
    expect(shown?.body).toBe("Nice work");
    expect(shown?.mine).toBe(false);
    expect(listComments(author, "prj_01").find((c) => c.id === id)?.mine).toBe(true);
  });

  it("known-bad: an empty body and a 2,001-character body are 422 and leave no comment", () => {
    const u = addUser("usr_chatty", "chatty@example.org", "Chatty");
    expectHttpError(() => postComment(u, "prj_01", { body: "" }), 422, "invalid");
    expectHttpError(() => postComment(u, "prj_01", { body: "x".repeat(2001) }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM comments")).toBe(0);
  });

  it("refuses a draft project with 403 not_submitted and exactly one authz.refused row", () => {
    const u = addUser("usr_reader", "reader@example.org", "Reader");
    h.sqlite.prepare("UPDATE projects SET status = 'draft', submitted_at = NULL WHERE id = 'prj_02'").run();
    const before = auditRows().length;

    expectHttpError(() => postComment(u, "prj_02", { body: "Hi" }), 403, "not_submitted");

    const rows = auditRows();
    expect(rows).toHaveLength(before + 1); // the refusal is the only new row
    expect(rows.filter((r) => r.action === "authz.refused")).toHaveLength(1);
    expect(JSON.stringify(rows.at(-1)!.after)).toContain('"not_submitted"');
    expect(count("SELECT count(*) AS n FROM comments")).toBe(0);
  });

  it("rate limit: the 6th comment in the window is 429, with one ratelimit.refused row and no 6th comment", () => {
    const u = addUser("usr_flood", "flood@example.org", "Flood");
    for (let i = 0; i < 5; i++) postComment(u, "prj_01", { body: `Comment number ${i}` });
    expect(auditCount("ratelimit.refused")).toBe(0);
    expect(count("SELECT count(*) AS n FROM comments")).toBe(5);

    expectHttpError(() => postComment(u, "prj_01", { body: "Sixth" }), 429, "rate_limited");

    expect(auditCount("ratelimit.refused")).toBe(1);
    expect(count("SELECT count(*) AS n FROM comments")).toBe(5);
  });
});

describe("hideComment", () => {
  it("refuses a participant with 403, an empty reason with 422, and hides in place with a reason, once", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Nice work" });

    expectHttpError(() => hideComment(participant(), id, { reason: "Spam" }), 403, "not_an_organizer");
    expectHttpError(() => hideComment(org(), id, { reason: "" }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM comments WHERE hidden_at IS NOT NULL")).toBe(0);

    hideComment(org(), id, { reason: "Personal attack" });
    const hidden = listComments(null, "prj_01").find((c) => c.id === id);
    expect(hidden?.body).toBeNull();
    expect(hidden?.hidden).toEqual({ reason: "Personal attack" });
    expect(auditCount("comment.hide")).toBe(1);

    hideComment(org(), id, { reason: "Personal attack" }); // idempotent: no second row
    expect(auditCount("comment.hide")).toBe(1);
    expect(listComments(null, "prj_01").find((c) => c.id === id)?.hidden).toEqual({ reason: "Personal attack" });
  });

  it("known-bad: a hidden comment's original text never reaches a reader", () => {
    const author = addUser("usr_secret", "secret@example.org", "Secret");
    const { id } = postComment(author, "prj_01", { body: "Nice work" });
    hideComment(org(), id, { reason: "Personal attack" });
    expect(JSON.stringify(listComments(null, "prj_01"))).not.toContain("Nice work");
  });
});
