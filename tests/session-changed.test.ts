import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/server/db/client";
import { runAssignment } from "@/server/dal/assignments";
import { createLoginSession } from "@/server/session";
import { organizer, sqlGet, withFixtureEvent } from "./support/fixture-harness";
import { afterRefusal } from "@/app/judge/[event]/refusal";
import { PERSON_HEADER, readAnnouncement, staleness } from "@/lib/session-watch";

// One browser keeps one sign-in for all its tabs. A judge console drawn for Judge A in tab A, after the organizer
// signed in in tab B, used to send its next save as the organizer: refused (403), but the score it showed looked
// saved until then. Now (1) the page learns whom the session belongs to (GET /api/auth/session, the channel),
// (2) a save that names its page's person is refused 409 session_changed before anything runs when the session is
// someone else's, and (3) a refused save puts the review back to what the server holds.

let cookie: string | undefined;
let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: (name: string) => (name === "session" && cookie ? { value: cookie } : undefined), delete: vi.fn() }),
  headers: async () => requestHeaders,
}));

const { GET: whoIsIt } = await import("@/app/api/auth/session/route");
const { PUT: putReview } = await import("@/app/api/judge/reviews/[assignment]/route");

withFixtureEvent();

beforeEach(() => {
  cookie = undefined;
  requestHeaders = new Headers();
});

type Row = { id: string; judge: string };
/** A fresh open review nobody has touched, from a top-up of the fixture. */
const openAssignment = () => {
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  return sqlGet<Row>(
    "SELECT a.id, a.judge_user_id AS judge FROM assignments a WHERE a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id) ORDER BY a.id LIMIT 1",
  )!;
};
const someoneElse = (not: string) => sqlGet<{ id: string }>("SELECT id FROM users WHERE id <> ? ORDER BY id LIMIT 1", not)!.id;
const nameOf = (id: string) => sqlGet<{ name: string }>("SELECT name FROM users WHERE id = ?", id)!.name;
const signInAs = (userId: string) => {
  cookie = createLoginSession(getDb(), userId).token;
};
const counts = () => sqlGet("SELECT (SELECT count(*) FROM scores) AS scores, (SELECT count(*) FROM audit_log) AS audit");

const save = (assignment: string, person?: string) => {
  requestHeaders = new Headers(person ? { [PERSON_HEADER]: person } : {});
  return putReview(
    new Request(`http://localhost:8080/api/judge/reviews/${assignment}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(person ? { [PERSON_HEADER]: person } : {}) },
      body: JSON.stringify({ values: {}, feedback: "Clear demo, good tests." }),
    }),
    { params: Promise.resolve({ assignment }) },
  );
};

describe("GET /api/auth/session", () => {
  it("answers person null with no session, and the session's person with one", async () => {
    expect(await (await whoIsIt()).json()).toEqual({ person: null });
    const a = openAssignment();
    signInAs(a.judge);
    const res = await whoIsIt();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person: { id: a.judge, name: nameOf(a.judge) } });
  });
});

describe("a save sent for the page's person after the session changed", () => {
  it("is 409 session_changed when another person is signed in now, and nothing is written or audited", async () => {
    const a = openAssignment();
    signInAs(someoneElse(a.judge));
    const before = counts();
    const res = await save(a.id, a.judge);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("session_changed");
    expect(body.message).toMatch(/^Not saved: .*Reload the page\./);
    expect(counts()).toEqual(before);
  });

  it("is 409 session_changed when the browser is signed out now", async () => {
    const a = openAssignment();
    const res = await save(a.id, a.judge);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/signed out/);
  });

  it("positive control: the page's own person saves as before (200)", async () => {
    const a = openAssignment();
    signInAs(a.judge);
    const res = await save(a.id, a.judge);
    expect(res.status).toBe(200);
  });

  it("positive control: without the header (the API, run.py, the hand checks) nothing changes: another person is 403 as before", async () => {
    const a = openAssignment();
    signInAs(someoneElse(a.judge));
    const res = await save(a.id);
    expect(res.status).toBe(403);
  });
});

describe("what a tab learns", () => {
  const judge = { id: "usr_a", name: "Diego Herrera" };
  const organizer = { id: "usr_o", name: "Demo Organizer" };
  it("same person, another person, signed out, and a visitor page after a sign-in", () => {
    expect(staleness(judge, { ...judge })).toEqual({ kind: "same" });
    expect(staleness(null, null)).toEqual({ kind: "same" });
    expect(staleness(judge, organizer)).toEqual({ kind: "changed", to: "Demo Organizer" });
    expect(staleness(judge, null)).toEqual({ kind: "signed-out" });
    expect(staleness(null, organizer)).toEqual({ kind: "changed", to: "Demo Organizer" });
  });
  it("reads only well-formed announcements", () => {
    expect(readAnnouncement({ type: "person", person: organizer })).toEqual(organizer);
    expect(readAnnouncement({ type: "person", person: null })).toBeNull();
    expect(readAnnouncement({ type: "person", person: { id: 3 } })).toBeUndefined();
    expect(readAnnouncement({ type: "other" })).toBeUndefined();
    expect(readAnnouncement("person")).toBeUndefined();
  });
});

describe("a refused save in the judge console", () => {
  const saved = { values: { impact: 3, craft: null }, feedback: "Saved words", privateNote: "" };
  const typed = { values: { impact: 5, craft: 2 }, feedback: "Typed words", privateNote: "note", readOnly: null, status: "pending" as const };
  it("goes back to what the server last accepted and says Not saved with the server's words", () => {
    const out = afterRefusal(typed, saved, 403, { error: "not_your_assignment", message: "A judge can only score their own assigned projects." });
    expect(out.review.values).toEqual(saved.values);
    expect(out.review.feedback).toBe("Saved words");
    expect(out.review.privateNote).toBe("");
    expect(out.message).toBe("Not saved: A judge can only score their own assigned projects.");
    expect(out.review.readOnly).toBe("A judge can only score their own assigned projects.");
  });
  it("a 409 session_changed ends the page's say too; a 422 keeps what was typed and leaves the review open", () => {
    expect(afterRefusal(typed, saved, 409, { error: "session_changed", message: "Not saved: signed out." }).review.readOnly).toBe("Not saved: signed out.");
    expect(afterRefusal(typed, saved, 409, { error: "session_changed", message: "Not saved: signed out." }).message).toBe("Not saved: signed out.");
    const invalid = afterRefusal(typed, saved, 422, { message: "A score is 1 to 5." });
    expect(invalid.review.values).toEqual(typed.values);
    expect(invalid.review.feedback).toBe("Typed words");
    expect(invalid.message).toBe("Not saved: A score is 1 to 5.");
    expect(invalid.review.readOnly).toBeNull();
    expect(afterRefusal(typed, saved, 422, {}).message).toBe("Not saved.");
  });
});
