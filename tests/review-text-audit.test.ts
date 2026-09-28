import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { payloadFor } from "@/server/webhooks";
import { latestAudit } from "@/server/dal/audit-log";
import { saveReview } from "@/server/dal/reviews";
import { textEdit, undoEdit, type TextEdit } from "@/lib/text-edit";
import type { Actor } from "@/server/authz";

// A judge's feedback to the team and private note to the organizers are rewritten by autosave as they type.
// The log keeps each save's edit (where, what was taken out, what was written), so a text an organizer may
// have read cannot be replaced with no trace of what it said, and no row carries the whole text again.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

/** A finished fixture review, its judge, and the feedback it holds now. */
function aReview() {
  const a = h.sqlite
    .prepare(
      "SELECT a.id, a.judge_user_id AS judge, a.project_id AS project, coalesce(c.feedback, '') AS feedback FROM assignments a " +
        "JOIN scores s ON s.assignment_id = a.id LEFT JOIN score_comments c ON c.score_id = s.id " +
        "WHERE a.event_id = 'evt_01' AND a.status = 'done' ORDER BY a.id LIMIT 1",
    )
    .get() as { id: string; judge: string; project: string; feedback: string };
  return { ...a, actor: actorById(a.judge) };
}

const reviewRows = (assignmentId: string) =>
  h.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "assignment"), eq(auditLog.targetId, assignmentId)))
    .orderBy(asc(auditLog.id))
    .all();
const editOf = (row: { after: unknown }, key: "feedbackEdit" | "privateNoteEdit") => (row.after as Record<string, TextEdit | undefined>)[key] ?? null;
const words = (n: number) => latestAudit(h.db, "evt_01", n).map((l) => l.parts.map((p) => p.text).join(""));

describe("the text edit a row keeps", () => {
  it("undoing it gives back the text before, for appends, cuts, rewrites and emoji (and a wrong edit does not)", () => {
    const pairs: [string, string][] = [
      ["", "Great work"],
      ["Great work", "Great work, but slow"],
      ["Great work, but slow", "Great, but slow"],
      ["Great, but slow", "Copied from last year's winner."],
      ["Copied from last year's winner.", ""],
      ["Nice \u{1F600} demo", "Nice \u{1F601} demo"],
      ["aaa", "aa"],
    ];
    for (const [before, after] of pairs) {
      const e = textEdit(before, after)!;
      expect(undoEdit(after, e), JSON.stringify([before, after])).toBe(before);
      // an emoji is never cut in two: every part is well-formed text
      for (const part of [e.removed, e.added]) expect(part).toBe(part.toWellFormed());
    }
    expect(textEdit("same", "same")).toBeNull();
    expect(textEdit("Great work", "Great work, but slow")).toEqual({ at: 10, removed: "", added: ", but slow" });
    // known-bad: a tampered edit does not rebuild the old text
    expect(undoEdit("Great, but slow", { at: 5, removed: " job", added: "" })).not.toBe("Great work, but slow");
  });
});

describe("a judge's texts in the audit log", () => {
  it("a rewrite of the feedback keeps what it took out and what it wrote; the log reads it in words", () => {
    const r = aReview();
    saveReview(r.actor, r.id, { values: {}, feedback: "Solid idea. The demo crashed twice." });
    saveReview(r.actor, r.id, { values: {}, feedback: "Solid idea." });
    const rows = reviewRows(r.id);
    expect(rows).toHaveLength(2);
    const cut = editOf(rows[1]!, "feedbackEdit")!;
    expect(cut).toEqual({ at: 11, removed: " The demo crashed twice.", added: "" });
    expect(undoEdit("Solid idea.", cut)).toBe("Solid idea. The demo crashed twice.");
    // the first row rebuilds the fixture's own comment, which no row had written before
    expect(undoEdit("Solid idea. The demo crashed twice.", editOf(rows[0]!, "feedbackEdit")!)).toBe(r.feedback);
    expect(words(1)[0]).toContain("edited their feedback to the team on");
    expect(words(1)[0]).toContain("took out “ The demo crashed twice.”");
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("every earlier version is rebuilt from the text as it stands and the log, walking back", () => {
    const r = aReview();
    const versions = [r.feedback, "Good", "Good job", "Good job, clean code", "Clean code", "", "Start over: weak README."];
    for (const v of versions.slice(1)) saveReview(r.actor, r.id, { values: {}, feedback: v });
    const edits = reviewRows(r.id).map((row) => editOf(row, "feedbackEdit")!);
    expect(edits).toHaveLength(versions.length - 1);
    let text = versions.at(-1)!;
    for (let i = edits.length - 1; i >= 0; i--) {
      text = undoEdit(text, edits[i]!);
      expect(text).toBe(versions[i]);
    }
  });

  it("typing adds only the new characters to each row, not the whole text again", () => {
    const r = aReview();
    saveReview(r.actor, r.id, { values: {}, feedback: "" });
    let typed = "";
    for (const word of ["The ", "onboarding ", "flow ", "is ", "very ", "clear."]) {
      typed += word;
      saveReview(r.actor, r.id, { values: {}, feedback: typed });
    }
    const rows = reviewRows(r.id).slice(1);
    expect(rows.map((row) => editOf(row, "feedbackEdit")!.added)).toEqual(["The ", "onboarding ", "flow ", "is ", "very ", "clear."]);
    expect(rows.every((row) => editOf(row, "feedbackEdit")!.removed === "")).toBe(true);
  });

  it("clearing the private note keeps what it said; a webhook still gets none of it", () => {
    const r = aReview();
    const note = "I know this team's lead; scored them anyway.";
    saveReview(r.actor, r.id, { values: {}, privateNote: note });
    saveReview(r.actor, r.id, { values: {}, privateNote: "" });
    const rows = reviewRows(r.id);
    expect(editOf(rows[1]!, "privateNoteEdit")).toEqual({ at: 0, removed: note, added: "" });
    expect(words(1)[0]).toContain("edited their private note on");
    for (const row of rows) {
      const body = payloadFor("dlv_test", { ...row, before: row.before, after: row.after }, "sample-hack-2026");
      expect(JSON.stringify(body)).not.toContain("I know this team");
      expect((body.data as { after: unknown }).after).toEqual({ project: r.project });
    }
  });

  it("a save that changes only a score writes no text edit (positive control)", () => {
    const r = aReview();
    const c = h.sqlite.prepare("SELECT key, scale_min AS min FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position LIMIT 1").get() as { key: string; min: number };
    const current = h.sqlite
      .prepare("SELECT i.value AS v FROM score_items i JOIN scores s ON s.id = i.score_id JOIN rubric_criteria k ON k.id = i.criterion_id WHERE s.assignment_id = ? AND k.key = ?")
      .get(r.id, c.key) as { v: number };
    saveReview(r.actor, r.id, { values: { [c.key]: current.v === c.min ? c.min + 1 : c.min } });
    const [row] = reviewRows(r.id);
    expect(editOf(row!, "feedbackEdit")).toBeNull();
    expect(editOf(row!, "privateNoteEdit")).toBeNull();
  });
});
