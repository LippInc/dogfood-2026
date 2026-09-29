import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { resetRateLimits } from "@/server/rate-limit";
import { castBallot, enterVoting } from "@/server/dal/voting";
import { makeVotingLink, saveVotingSettings, voidVoter } from "@/server/dal/voting-organizer";
import { deleteComment, hideComment, postComment, unhideComment } from "@/server/dal/comments";
import type { Actor } from "@/server/authz";

// The community vote and the comments are final in the database where the app never changes them
// (src/server/db/triggers.ts, drizzle/0019_votes_comments.sql). Each refusal has its positive control, through the
// app's own functions where it has one (a ballot changed while voting is open, a ballot set aside, a comment hidden,
// unhidden and deleted), and a planted control: with the trigger dropped the same statement gets through.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  resetRateLimits();
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const run = (sql: string, ...params: (string | number)[]) => h.sqlite.prepare(sql).run(...params);
const count = (sql: string, ...params: string[]) => (h.sqlite.prepare(sql).get(...params) as { n: number }).n;
const FINAL_VOTE = /votes: voting has closed, so the ballots are final/;

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const org = () => actorById("usr_organizer");
const userIdByEmail = (email: string) => (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;

const openVoting = () =>
  saveVotingSettings(org(), "evt_01", {
    votingOpenAt: "2026-01-01T00:00",
    votingCloseAt: "2999-01-01T00:00",
    modes: ["account", "listed", "link"],
    votesPerVoter: "3",
    countLink: true,
  });
/** The window's close moved into the past, as the clock would: the app can no longer move a closed window. */
const closeVoting = () => run("UPDATE events SET voting_close_at = ? WHERE id = 'evt_01'", new Date(Date.now() - 1000).toISOString());

/** submitted projects that are no merged copy: the ones on every ballot */
const onBallot = () =>
  (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL ORDER BY id").all() as { id: string }[]).map((r) => r.id);

let ip = 0;
function linkBallot(picks: string[]) {
  const { code } = makeVotingLink(org(), "evt_01");
  const { token } = enterVoting(code, { ip: `10.77.0.${++ip}`, agent: "Agent" });
  const { voterId } = castBallot(null, "evt_01", token, { projectIds: picks }, { ip: "10.77.0.1", agent: "Agent" }) as { voterId: string };
  return { token, voterId };
}

describe("votes: final once voting has closed, never changed in place", () => {
  it("positive control: while voting is open the app changes a ballot (picks off, new picks on) and sets one aside", () => {
    openVoting();
    const projects = onBallot();
    const { token, voterId } = linkBallot([projects[0]!, projects[1]!]);
    castBallot(null, "evt_01", token, { projectIds: [projects[2]!] }, { ip: "10.77.0.1", agent: "Agent" });
    expect(h.sqlite.prepare("SELECT project_id AS p FROM votes WHERE voter_id = ?").all(voterId)).toEqual([{ p: projects[2] }]);
    voidVoter(org(), "evt_01", { voterId, reason: "same browser twice" });
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", voterId)).toBe(1); // voiding keeps the picks
  });

  it("known-bad: a pick changed in place is refused even while voting is open; without the trigger it goes through", () => {
    openVoting();
    const projects = onBallot();
    const { voterId } = linkBallot([projects[0]!]);
    const moved = () => run("UPDATE votes SET project_id = ? WHERE voter_id = ?", projects[1]!, voterId);
    expect(moved).toThrow(/votes: a pick is never changed in place/);
    expect(() => run("UPDATE votes SET created_at = ? WHERE voter_id = ?", NOW, voterId)).toThrow(/never changed in place/);
    h.sqlite.exec("DROP TRIGGER votes_no_update");
    moved();
    expect(h.sqlite.prepare("SELECT project_id AS p FROM votes WHERE voter_id = ?").get(voterId)).toEqual({ p: projects[1] });
  });

  it("known-bad: once the window has closed no pick goes on or comes off; while it was open both did", () => {
    openVoting();
    const projects = onBallot();
    const { voterId } = linkBallot([projects[0]!]);
    // the app's own statements while open (castBallot takes the picks off and puts the new ones on)
    run("DELETE FROM votes WHERE voter_id = ?", voterId);
    run("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)", voterId, projects[0]!, NOW);

    closeVoting();
    expect(() => run("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)", voterId, projects[1]!, NOW)).toThrow(FINAL_VOTE);
    expect(() => run("DELETE FROM votes WHERE voter_id = ?", voterId)).toThrow(FINAL_VOTE);
    expect(count("SELECT count(*) AS n FROM votes WHERE voter_id = ?", voterId)).toBe(1);

    h.sqlite.exec("DROP TRIGGER votes_closed_insert");
    h.sqlite.exec("DROP TRIGGER votes_closed_delete");
    run("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)", voterId, projects[1]!, NOW);
    run("DELETE FROM votes WHERE voter_id = ? AND project_id = ?", voterId, projects[0]!);
    expect(h.sqlite.prepare("SELECT project_id AS p FROM votes WHERE voter_id = ?").all(voterId)).toEqual([{ p: projects[1] }]);
  });

  it("known-bad: publishing the results ends the vote in the database too, whatever the window says", () => {
    openVoting();
    const projects = onBallot();
    const { voterId } = linkBallot([projects[0]!]);
    run("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'", NOW); // the window still reads 2999
    expect(() => run("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)", voterId, projects[1]!, NOW)).toThrow(FINAL_VOTE);
    expect(() => run("DELETE FROM votes WHERE voter_id = ?", voterId)).toThrow(FINAL_VOTE);
  });
});

describe("comments: never rewritten, and a hidden one stays", () => {
  const member = () => actorById(userIdByEmail("member1_1@example.org"));
  const submitted = () => (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' ORDER BY id LIMIT 1").get() as { id: string }).id;
  const row = (id: string) => h.sqlite.prepare("SELECT body, user_id AS u, project_id AS p, created_at AS c, hidden_at AS hid FROM comments WHERE id = ?").get(id);

  it("positive control: the app hides, unhides and its author deletes a comment", () => {
    const { id } = postComment(member(), submitted(), { body: "Lovely demo" }) as { id: string };
    hideComment(org(), id, { reason: "off topic" });
    unhideComment(org(), id);
    deleteComment(member(), id);
    expect(row(id)).toBeUndefined();
  });

  it("known-bad: the words, author, project and time are refused; without the trigger they change", () => {
    const { id } = postComment(member(), submitted(), { body: "Lovely demo" }) as { id: string };
    const other = (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND id <> ? ORDER BY id LIMIT 1").get(submitted()) as { id: string }).id;
    const WORDS = /comments: a comment's words, author, project and time never change/;
    expect(() => run("UPDATE comments SET body = 'Terrible demo' WHERE id = ?", id)).toThrow(WORDS);
    expect(() => run("UPDATE comments SET user_id = 'usr_organizer' WHERE id = ?", id)).toThrow(WORDS);
    expect(() => run("UPDATE comments SET project_id = ? WHERE id = ?", other, id)).toThrow(WORDS);
    expect(() => run("UPDATE comments SET created_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", id)).toThrow(WORDS);
    expect(row(id)).toMatchObject({ body: "Lovely demo" });
    h.sqlite.exec("DROP TRIGGER comments_words_final");
    run("UPDATE comments SET body = 'Terrible demo' WHERE id = ?", id);
    expect(row(id)).toMatchObject({ body: "Terrible demo" });
  });

  it("known-bad: a hidden comment cannot be deleted, unhidden it can; without the trigger it goes", () => {
    const { id } = postComment(member(), submitted(), { body: "Lovely demo" }) as { id: string };
    hideComment(org(), id, { reason: "off topic" });
    expect(() => run("DELETE FROM comments WHERE id = ?", id)).toThrow(/comments: a hidden comment stays until the organizers unhide it/);
    expect(row(id)).toMatchObject({ body: "Lovely demo" });
    h.sqlite.exec("DROP TRIGGER comments_hidden_stays");
    run("DELETE FROM comments WHERE id = ?", id);
    expect(row(id)).toBeUndefined();
  });
});
