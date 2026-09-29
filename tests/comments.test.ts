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
import { deleteComment, hideComment, listComments, postComment, unhideComment } from "@/server/dal/comments";
import { verifyAuditChain } from "@/server/audit";
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
  setHandleForTests(h); // the comments DAL goes through getDb()
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

  it("rate limit: 30 comments in the window pass, the 31st is 429, with one ratelimit.refused row and no 31st comment", () => {
    const u = addUser("usr_flood", "flood@example.org", "Flood");
    for (let i = 0; i < 30; i++) postComment(u, "prj_01", { body: `Comment number ${i}` });
    expect(auditCount("ratelimit.refused")).toBe(0);
    expect(count("SELECT count(*) AS n FROM comments")).toBe(30);

    expectHttpError(() => postComment(u, "prj_01", { body: "One too many" }), 429, "rate_limited");

    expect(auditCount("ratelimit.refused")).toBe(1);
    expect(count("SELECT count(*) AS n FROM comments")).toBe(30);
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
    const hidden = listComments(org(), "prj_01").find((c) => c.id === id);
    expect(hidden?.body).toBeNull();
    expect(hidden?.hidden).toEqual({ reason: "Personal attack" });
    expect(auditCount("comment.hide")).toBe(1);

    hideComment(org(), id, { reason: "Personal attack" }); // idempotent: no second row
    expect(auditCount("comment.hide")).toBe(1);
    expect(listComments(org(), "prj_01").find((c) => c.id === id)?.hidden).toEqual({ reason: "Personal attack" });
  });

  it("known-bad: a hidden comment's original text never reaches a reader", () => {
    const author = addUser("usr_secret", "secret@example.org", "Secret");
    const { id } = postComment(author, "prj_01", { body: "Nice work" });
    hideComment(org(), id, { reason: "Personal attack" });
    for (const reader of [null, org(), author]) expect(JSON.stringify(listComments(reader, "prj_01"))).not.toContain("Nice work");
  });
});

describe("deleteComment: the author takes their own comment back", () => {
  const exists = (id: string) => count(`SELECT count(*) AS n FROM comments WHERE id = '${id}'`);

  it("the author deletes it for good: gone from the list and the table, one comment.deleted row without the words", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Posted on the wrong project" });

    expect(deleteComment(author, id)).toEqual({ id, deleted: true });

    expect(exists(id)).toBe(0);
    expect(listComments(null, "prj_01").find((c) => c.id === id)).toBeUndefined();
    const row = auditRows().at(-1)!;
    expect(row).toMatchObject({ action: "comment.deleted", actorUserId: author.userId, targetId: "prj_01", before: { comment: id, chars: 27 } });
    expect(JSON.stringify(row)).not.toContain("wrong project");
  });

  it("known-bad: someone else, even an organizer, is 403 not_your_comment (one refusal row naming the comment); no session is 401; the comment stays", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Mine" });
    const other = addUser("usr_other", "other@example.org", "Other");
    expectHttpError(() => deleteComment(other, id), 403, "not_your_comment");
    expect(auditRows().at(-1)).toMatchObject({ action: "authz.refused", targetType: "comment", targetId: id });
    expectHttpError(() => deleteComment(org(), id), 403, "not_your_comment");
    expectHttpError(() => deleteComment(null, id), 401, "unauthenticated");
    expectHttpError(() => deleteComment(author, "cmt_nope"), 404, "not_found");
    expect(exists(id)).toBe(1);
  });

  it("known-bad: a comment the organizers hid stays (403 comment_hidden); once they unhide it, its author can delete it", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Rude words" });
    hideComment(org(), id, { reason: "Personal attack" });
    expectHttpError(() => deleteComment(author, id), 403, "comment_hidden");
    expect(exists(id)).toBe(1);
    unhideComment(org(), id);
    deleteComment(author, id);
    expect(exists(id)).toBe(0);
  });
});

describe("unhideComment: an organizer shows a hidden comment again", () => {
  it("the body comes back, one comment.unhide row keeps the old reason; unhiding a shown comment writes nothing; it can be hidden again", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Fair point after all" });
    hideComment(org(), id, { reason: "Looked like spam" });

    unhideComment(org(), id);

    const shown = listComments(null, "prj_01").find((c) => c.id === id);
    expect(shown?.hidden).toBeNull();
    expect(shown?.body).toBe("Fair point after all");
    expect(auditRows().at(-1)).toMatchObject({ action: "comment.unhide", targetId: "prj_01", before: { comment: id, reason: "Looked like spam" } });
    const rows = auditRows().length;
    unhideComment(org(), id);
    expect(auditRows().length).toBe(rows);
    hideComment(org(), id, { reason: "Spam after all" });
    expect(listComments(org(), "prj_01").find((c) => c.id === id)?.hidden).toEqual({ reason: "Spam after all" });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("known-bad: a participant, and the comment's own author, are 403 not_an_organizer; no session is 401; the comment stays hidden", () => {
    const author = addUser("usr_author", "author@example.org", "Author");
    const { id } = postComment(author, "prj_01", { body: "Rude words" });
    hideComment(org(), id, { reason: "Personal attack" });
    expectHttpError(() => unhideComment(participant(), id), 403, "not_an_organizer");
    expectHttpError(() => unhideComment(actorById(author.userId), id), 403, "not_an_organizer");
    expectHttpError(() => unhideComment(null, id), 401, "unauthenticated");
    expect(listComments(org(), "prj_01").find((c) => c.id === id)?.hidden).toEqual({ reason: "Personal attack" });
  });
});

describe("a hidden comment's placeholder: organizers and the author only", () => {
  it("a visitor, another signed-in person, a participant and a judge see one comment fewer, with neither the author's name nor the reason", () => {
    const author = addUser("usr_hidden", "hidden@example.org", "Hidden Author");
    const { id } = postComment(author, "prj_01", { body: "Off-topic question" });
    const other = addUser("usr_bystander", "bystander@example.org", "Bystander");
    const kept = postComment(other, "prj_01", { body: "Shown comment" }).id;
    hideComment(org(), id, { reason: "Off-topic question here" });

    const judge = actorById(userIdByEmail("tomas.varga@example.org"));
    for (const reader of [null, other, participant(), judge]) {
      const list = listComments(reader, "prj_01");
      expect(list.map((c) => c.id)).toEqual([kept]);
      const text = JSON.stringify(list);
      expect(text).not.toContain("Hidden Author");
      expect(text).not.toContain("Off-topic question here");
    }
  });

  it("positive control: the event's organizers, an administrator and the author still get the placeholder with name and reason", () => {
    const author = addUser("usr_hidden", "hidden@example.org", "Hidden Author");
    const { id } = postComment(author, "prj_01", { body: "Off-topic question" });
    hideComment(org(), id, { reason: "Off-topic question here" });

    const admin: Actor = { ...addUser("usr_admin2", "admin2@example.org", "Admin"), isAdmin: true };
    for (const reader of [org(), admin, actorById(author.userId)]) {
      const c = listComments(reader, "prj_01").find((x) => x.id === id);
      expect(c?.author).toBe("Hidden Author");
      expect(c?.hidden).toEqual({ reason: "Off-topic question here" });
      expect(c?.body).toBeNull();
    }
  });

  it("known-bad: an organizer of another event reads this one as a visitor does", () => {
    const author = addUser("usr_hidden", "hidden@example.org", "Hidden Author");
    const { id } = postComment(author, "prj_01", { body: "Off-topic question" });
    hideComment(org(), id, { reason: "Off-topic question here" });
    const elsewhere: Actor = { ...addUser("usr_elsewhere", "elsewhere@example.org", "Elsewhere"), roles: [{ eventId: "evt_other", role: "organizer" }] };
    expect(listComments(elsewhere, "prj_01").find((x) => x.id === id)).toBeUndefined();
  });
});
