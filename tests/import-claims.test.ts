import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import type { Actor } from "@/server/authz";

// claimAccount, signUp and signInWithPassword set the session cookie
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");
const { claimAccount, countBeyondReach, countWithoutPassword, describeClaim, makeClaimLinks } = await import("@/server/dal/claims");
const { addOrganizer } = await import("@/server/dal/organizers");
const { signUp } = await import("@/server/dal/accounts");
const { signInWithPassword } = await import("@/server/dal/auth");

const NOW = "2026-09-26T12:00:00.000Z";
const EVENT = "evt_01";

/** The administrator of portal B (no fixtures there, so no demo organizer): created by SQL. */
const ADMIN_B = { id: "usr_admin_b", email: "admin-b@example.org", name: "Second Portal Admin" } as const;

let ha: Handle; // portal A: the fixture event, imported at boot
let hb: Handle | null = null; // portal B, opened by the round-trip tests

beforeEach(() => {
  ha = openDatabase(":memory:");
  runMigrations(ha, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(ha.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(ha.db, EVENT, NOW); // makes usr_organizer an admin (is_admin = 1) and organizer of evt_01
  setHandleForTests(ha);
  resetRateLimits();
});

afterEach(() => {
  setHandleForTests(null);
  ha.sqlite.close();
  if (hb) {
    hb.sqlite.close();
    hb = null;
  }
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

const nOf = (hx: Handle, sql: string, ...params: (string | number)[]) =>
  (hx.sqlite.prepare(sql).get(...params) as { n: number }).n;
const one = <T>(hx: Handle, sql: string, ...params: (string | number)[]) => hx.sqlite.prepare(sql).get(...params) as T;
const auditIn = (hx: Handle) => hx.db.select().from(auditLog).orderBy(auditLog.id).all();

/** An actor as the session layer would build it, with the admin flag read from the row. */
function actorIn(hx: Handle, userId: string): Actor {
  const u = one<{ id: string; name: string; email: string; isAdmin: number }>(
    hx,
    "SELECT id, name, email, is_admin AS isAdmin FROM users WHERE id = ?",
    userId,
  );
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = hx.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin === 1, roles, sessionKind: "login" };
}

const actorById = (userId: string) => actorIn(ha, userId);
const organizer = () => actorById("usr_organizer");

/** A member of a team that submitted a project, found the way records.test.ts finds one. */
function anyParticipantId(): string {
  const row = one<{ id: string }>(
    ha,
    "SELECT tm.user_id AS id FROM team_members tm " +
      "JOIN projects p ON p.team_id = tm.team_id " +
      "WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = ? LIMIT 1",
    EVENT,
  );
  if (!row) throw new Error("no participant on a submitted team in the fixture");
  return row.id;
}

/** Portal B: a fresh in-memory database with migrations and one admin, and nothing else. */
function openB(): Handle {
  const fresh = openDatabase(":memory:");
  runMigrations(fresh, path.join(process.cwd(), "drizzle"));
  fresh.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 1, ?)")
    .run(ADMIN_B.id, ADMIN_B.email, ADMIN_B.name, NOW);
  return fresh;
}

type FixtureFile = {
  event: { id: string; name: string; submissions_close: string };
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: { id: string; team: string; track: string; title: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number | null> }[];
};

/** What one portal's export says the event holds, counted from the database. */
function countsOf(hx: Handle) {
  const q = (sql: string): number => (hx.sqlite.prepare(sql).get() as { n: number }).n;
  return {
    tracks: q(`SELECT count(*) AS n FROM tracks WHERE event_id = '${EVENT}'`),
    teams: q(`SELECT count(*) AS n FROM teams WHERE event_id = '${EVENT}'`),
    teamMembers: q(`SELECT count(*) AS n FROM team_members WHERE event_id = '${EVENT}'`),
    submittedProjects: q(`SELECT count(*) AS n FROM projects WHERE event_id = '${EVENT}' AND status = 'submitted'`),
    doneAssignments: q(`SELECT count(*) AS n FROM assignments WHERE event_id = '${EVENT}' AND status = 'done'`),
    scoreItems: q(
      "SELECT count(*) AS n FROM score_items si " +
        "JOIN scores sc ON sc.id = si.score_id " +
        "JOIN assignments a ON a.id = sc.assignment_id " +
        `WHERE a.event_id = '${EVENT}'`,
    ),
  };
}

const sha256hex = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const tokenOf = (link: { path: string }) => link.path.slice("/claim/".length);

describe("bulk import, export and account claims", () => {
  it("an import needs an administrator: no session 401, a participant 403 even before the body is read, a non-file from the admin 422", () => {
    expectHttpError(() => importEventFile(null, {}), 401, "unauthenticated");

    const participant = actorById(anyParticipantId());
    expectHttpError(() => importEventFile(participant, { event: { id: "evt_x" } }), 403, "not_an_admin");
    expectHttpError(() => importEventFile(participant, "not even an object"), 403, "not_an_admin"); // the refusal comes first

    const admin = organizer();
    expect(admin.isAdmin).toBe(true); // ensureDemoOrganizer makes usr_organizer an admin
    expectHttpError(() => importEventFile(admin, {}), 422, "invalid");
    expectHttpError(() => importEventFile(admin, undefined), 422, "invalid");

    // the message says what is wrong in plain words, not Zod's raw dump
    const messageOf = (body: unknown) => {
      try {
        importEventFile(admin, body);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    };
    expect(messageOf(undefined)).toMatch(/not a JSON object with an event in it/);
    expect(messageOf(undefined)).not.toMatch(/✖/);
    expect(messageOf({ event: { name: "No id" }, tracks: [], judges: [], teams: [], projects: [], scores: [] })).toMatch(/event\.id: /);
    // a project link is a web address on the way in, as in the project form
    const withScriptLink = loadFixtureFile(path.join(process.cwd(), "fixtures.json")).fixture;
    withScriptLink.projects[0]!.repo_url = "javascript:alert(1)";
    expect(messageOf(withScriptLink)).toMatch(/projects\.0\.repo_url: must be a full URL, starting with https:\/\//);
  });

  it("round trip: an export from portal A imports into a fresh portal B with the same tables, the same normalized CSV, and the importer as organizer", () => {
    const parsed = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    const csvA = exportFile(organizer(), EVENT, "normalized.csv").body;

    hb = openB();
    setHandleForTests(hb);
    const adminB = actorIn(hb, ADMIN_B.id);
    const report = importEventFile(adminB, parsed);
    expect(report.eventId).toBe(EVENT);

    expect(countsOf(hb)).toEqual(countsOf(ha));
    // the actor is re-read: the organizer role it gained came with the import
    expect(exportFile(actorIn(hb, ADMIN_B.id), EVENT, "normalized.csv").body).toBe(csvA);

    // the admin became an organizer of what they imported, and both steps are audited under their id
    expect(nOf(hb, "SELECT count(*) AS n FROM user_roles WHERE user_id = ? AND event_id = ? AND role = 'organizer'", ADMIN_B.id, EVENT)).toBe(1);
    const rows = auditIn(hb);
    const imports = rows.filter((r) => r.action === "fixtures.import");
    expect(imports).toHaveLength(1);
    expect(imports[0]!.actorUserId).toBe(ADMIN_B.id);
    expect(rows.some((r) => r.action === "event.organizer_added" && r.actorUserId === ADMIN_B.id)).toBe(true);

    setHandleForTests(ha); // switch back; afterEach closes both
  });

  it("importing the same file again inserts nothing and adds no second import audit row", () => {
    const parsed = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;

    hb = openB();
    setHandleForTests(hb);
    const adminB = actorIn(hb, ADMIN_B.id);
    importEventFile(adminB, parsed);
    const before = countsOf(hb);
    const importRows = () => nOf(hb!, "SELECT count(*) AS n FROM audit_log WHERE action = 'fixtures.import'");
    expect(importRows()).toBe(1);

    // a second request, so the actor is read again: it carries the organizer role the first import gave it
    const again = importEventFile(actorIn(hb, ADMIN_B.id), parsed);
    for (const [table, n] of Object.entries(again.inserted)) expect(n, `inserted.${table}`).toBe(0);
    expect(countsOf(hb)).toEqual(before);
    expect(importRows()).toBe(1);

    setHandleForTests(ha);
  });

  it("the export is the fixture format: parseable, exactly the submitted projects, every score about a listed judge and project, captains first", () => {
    const parsed = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    FixtureSchema.parse(parsed); // throws unless the export is a valid fixture file
    expect(parsed.event.id).toBe(EVENT);

    const submitted = new Set(
      (ha.sqlite.prepare("SELECT id FROM projects WHERE event_id = ? AND status = 'submitted'").all(EVENT) as { id: string }[]).map((r) => r.id),
    );
    expect(parsed.projects.map((p) => p.id).sort()).toEqual(Array.from(submitted).sort());

    const judgeIds = new Set(parsed.judges.map((j) => j.id));
    const projectIds = new Set(parsed.projects.map((p) => p.id));
    expect(parsed.scores.length).toBeGreaterThan(0);
    for (const s of parsed.scores) {
      expect(judgeIds.has(s.judge), `score by ${s.judge}`).toBe(true);
      expect(projectIds.has(s.project), `score of ${s.project}`).toBe(true);
    }

    // the exporter puts the captain first because the importer makes the first member captain
    for (const t of parsed.teams) {
      const captain = one<{ email: string }>(
        ha,
        "SELECT u.email AS email FROM team_members tm JOIN users u ON u.id = tm.user_id " +
          "WHERE tm.event_id = ? AND tm.team_id = ? AND tm.role = 'captain'",
        EVENT,
        t.id,
      );
      expect(captain?.email, `captain of ${t.id}`).toBe(t.members[0]);
    }
  });

  it("claim links: one per passwordless person in the event but the organizer asking, well-formed paths, only hashes stored; a participant is refused", () => {
    const expected = one<{ n: number }>(
      ha,
      "SELECT count(*) AS n FROM users WHERE password_hash IS NULL AND id <> ? " +
        "AND (id IN (SELECT user_id FROM team_members WHERE event_id = ?) OR id IN (SELECT user_id FROM user_roles WHERE event_id = ?))",
      organizer().userId,
      EVENT,
      EVENT,
    )!.n;
    expect(expected).toBeGreaterThan(0);

    const { links } = makeClaimLinks(organizer(), EVENT);
    expect(links).toHaveLength(expected);
    expect(new Set(links.map((l) => l.email)).size).toBe(expected); // one link per person
    for (const link of links) expect(link.path).toMatch(/^\/claim\/[A-Za-z0-9]+$/);

    // the token is shown once and stored only as its SHA-256
    for (const link of links) {
      const token = tokenOf(link);
      expect(nOf(ha, "SELECT count(*) AS n FROM account_claims WHERE token_hash = ?", token)).toBe(0);
      expect(nOf(ha, "SELECT count(*) AS n FROM account_claims WHERE token_hash = ?", sha256hex(token))).toBe(1);
    }

    expect(countWithoutPassword(organizer(), EVENT)).toBe(expected);
    expectHttpError(() => makeClaimLinks(actorById(anyParticipantId()), EVENT), 403, "not_an_organizer");
    expectHttpError(() => countWithoutPassword(actorById(anyParticipantId()), EVENT), 403, "not_an_organizer");
  });

  it("claiming: the page names the person, a short password is refused without burning the link, a good one sets it, and the link then dies", async () => {
    const link = makeClaimLinks(organizer(), EVENT).links[0]!;
    const token = tokenOf(link);

    const page = describeClaim(token);
    expect(page.email).toBe(link.email);
    expect(page.eventName).toBe("Sample Hack 2026"); // the fixture event's name

    await expectHttpErrorAsync(() => claimAccount(token, { password: "short" }), 422, "invalid");
    expect(describeClaim(token).email).toBe(link.email); // the link still works

    const password = "a long enough password";
    const user = one<{ id: string }>(ha, "SELECT id FROM users WHERE email = ?", link.email)!;
    const claimed = await claimAccount(token, { password });
    expect(claimed).toEqual({ userId: user.id });
    expect(nOf(ha, "SELECT count(*) AS n FROM users WHERE id = ? AND password_hash IS NOT NULL", user.id)).toBe(1);
    expect(nOf(ha, "SELECT count(*) AS n FROM audit_log WHERE action = 'user.claim' AND target_id = ?", user.id)).toBe(1);

    await expectHttpErrorAsync(() => claimAccount(token, { password }), 410, "claim_used");
    expectHttpError(() => describeClaim(token), 410, "claim_used");

    expect(await signInWithPassword(link.email, password)).toEqual({ ok: true, userId: user.id });
  });

  it("a new batch replaces the unused links, and a link past its expiry answers claim_expired", async () => {
    const first = makeClaimLinks(organizer(), EVENT).links;
    await claimAccount(tokenOf(first[0]!), { password: "a long enough password" });

    const second = makeClaimLinks(organizer(), EVENT).links;
    expect(second).toHaveLength(first.length - 1); // the claimed person has a password now
    expect(second.map((l) => l.email)).not.toContain(first[0]!.email);

    // a first-batch token for someone else no longer exists: replaced, not duplicated
    expectHttpError(() => describeClaim(tokenOf(first[1]!)), 404, "not_found");

    // expiry is decided at read time; created_at must move back too (expires_at > created_at is a table CHECK)
    const target = second[0]!;
    ha.sqlite
      .prepare("UPDATE account_claims SET created_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 3_500_000).toISOString(), sha256hex(tokenOf(target)));
    expectHttpError(() => describeClaim(tokenOf(target)), 410, "claim_expired");
  });

  it("sign-up against a imported address: 409 account_imported without a password, 409 email_taken with one; a fresh address still works", async () => {
    const links = makeClaimLinks(organizer(), EVENT).links;
    const passwordless = links[0]!;
    const toClaim = links[1]!;

    await expectHttpErrorAsync(
      () => signUp({ name: "Someone", email: passwordless.email, password: "a long enough password" }),
      409,
      "account_imported",
    );

    await claimAccount(tokenOf(toClaim), { password: "a long enough password" });
    await expectHttpErrorAsync(
      () => signUp({ name: "Someone", email: toClaim.email, password: "a long enough password" }),
      409,
      "email_taken",
    );

    const fresh = await signUp({ name: "New Person", email: "new.person@example.org", password: "a long enough password" });
    expect(nOf(ha, "SELECT count(*) AS n FROM users WHERE id = ? AND password_hash IS NOT NULL", fresh.userId)).toBe(1);
  });

  it("the audit chain still verifies after issuing claim links and claiming one", async () => {
    const links = makeClaimLinks(organizer(), EVENT).links;
    await claimAccount(tokenOf(links[0]!), { password: "a long enough password" });
    expect(verifyAuditChain(ha.db).ok).toBe(true);
  });
});

describe("importing onto what this portal already holds", () => {
  const TWO = "evt_02";
  /** The fixture event's own export, as a second event: every track, team, project and judge id reused, other people. */
  function secondEvent(): FixtureFile {
    const one = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    return {
      ...one,
      event: { ...one.event, id: TWO, name: "Second Hack 2026" },
      judges: one.judges.map((j) => ({ ...j, email: `two.${j.email}` })),
      teams: one.teams.map((t) => ({ ...t, members: t.members.map((m) => `two.${m}`) })),
    };
  }
  const rowsOf = (event: string) =>
    ha.sqlite
      .prepare(
        "SELECT p.id, p.team_id, p.track_id, p.title, a.judge_user_id, si.value FROM projects p " +
          "LEFT JOIN assignments a ON a.project_id = p.id LEFT JOIN scores s ON s.assignment_id = a.id " +
          "LEFT JOIN score_items si ON si.score_id = s.id WHERE p.event_id = ? ORDER BY p.id, a.id, si.criterion_id",
      )
      .all(event);

  it("a second event whose file reuses the first one's ids gets rows of its own, the first stays exactly as it was, and importing it again finds the same rows", () => {
    const file = secondEvent();
    const first = rowsOf(EVENT);
    const report = importEventFile(organizer(), file);

    expect(report.eventId).toBe(TWO);
    const renamed = (kind: string) => report.renamed.filter((r) => r.kind === kind);
    expect(renamed("track")).toHaveLength(file.projects.length ? new Set(file.projects.map((p) => p.track)).size : 0);
    expect(renamed("team")).toHaveLength(file.teams.length);
    expect(renamed("project")).toHaveLength(file.projects.length);
    expect(renamed("judge")).toHaveLength(file.judges.length);
    expect(renamed("project")[0]!.to).toBe(`${renamed("project")[0]!.from}.${TWO}`);

    expect(rowsOf(EVENT)).toEqual(first);
    // nothing of the second event points at a row of the first
    const crossing = (sql: string) => nOf(ha, sql, TWO);
    expect(crossing("SELECT count(*) AS n FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.event_id = ? AND t.event_id <> p.event_id")).toBe(0);
    expect(crossing("SELECT count(*) AS n FROM projects p JOIN tracks t ON t.id = p.track_id WHERE p.event_id = ? AND t.event_id <> p.event_id")).toBe(0);
    expect(crossing("SELECT count(*) AS n FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.event_id = ? AND p.event_id <> a.event_id")).toBe(0);
    expect(crossing("SELECT count(*) AS n FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.event_id = ? AND t.event_id <> m.event_id")).toBe(0);
    // each judge of the second event is the person the file names, not the first event's judge with the same id
    expect(crossing("SELECT count(*) AS n FROM assignments a JOIN users u ON u.id = a.judge_user_id WHERE a.event_id = ? AND u.email NOT LIKE 'two.%'")).toBe(0);
    expect(nOf(ha, "SELECT count(*) AS n FROM assignments WHERE event_id = ?", TWO)).toBe(nOf(ha, "SELECT count(*) AS n FROM assignments WHERE event_id = ?", EVENT));

    const again = importEventFile(organizer(), file);
    for (const [table, n] of Object.entries(again.inserted)) expect(n, `inserted.${table}`).toBe(0);
    expect(again.renamed).toEqual(report.renamed);
    expect(rowsOf(EVENT)).toEqual(first);
  });

  it("an administrator who is not the event's organizer cannot import onto it: 403 audited, nothing added, no organizer role gained", () => {
    ha.sqlite
      .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 1, ?)")
      .run("usr_admin_two", "admin-two@example.org", "Another Admin", NOW);
    const file = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    file.teams.push({ id: "tm_99", name: "Late Team", members: ["late@example.org"] });
    file.projects.push({ id: "prj_99", team: "tm_99", track: file.projects[0]!.track, title: "Late Entry", submitted_at: NOW } as FixtureFile["projects"][number]);
    const before = countsOf(ha);

    expectHttpError(() => importEventFile(actorIn(ha, "usr_admin_two"), file), 403, "not_an_organizer");
    expect(countsOf(ha)).toEqual(before);
    expect(nOf(ha, "SELECT count(*) AS n FROM user_roles WHERE user_id = 'usr_admin_two'")).toBe(0);
    const refusal = auditIn(ha).at(-1)!;
    expect(refusal.action).toBe("authz.refused");
    expect(refusal.actorUserId).toBe("usr_admin_two");
    expect(refusal.after).toMatchObject({ attempted: "event.manage", code: "not_an_organizer" });
  });

  it("once results are published, an import that would add to the event answers 409 and changes nothing; a file with nothing new still passes", () => {
    const file = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    importEventFile(organizer(), file); // whatever the export adds over the boot's import, before publishing
    ha.sqlite.prepare("UPDATE events SET results_published_at = ? WHERE id = ?").run(NOW, EVENT);
    const before = countsOf(ha);
    const imports = () => nOf(ha, "SELECT count(*) AS n FROM fixture_imports");
    const importsBefore = imports();

    const same = importEventFile(organizer(), file);
    for (const [table, n] of Object.entries(same.inserted)) expect(n, `inserted.${table}`).toBe(0);

    const late = structuredClone(file);
    late.teams.push({ id: "tm_99", name: "Late Team", members: ["late@example.org"] });
    late.projects.push({ id: "prj_99", team: "tm_99", track: file.projects[0]!.track, title: "Late Entry", submitted_at: NOW } as FixtureFile["projects"][number]);
    expectHttpError(() => importEventFile(organizer(), late), 409, "results_published");
    expect(countsOf(ha)).toEqual(before);
    expect(nOf(ha, "SELECT count(*) AS n FROM projects WHERE id = 'prj_99'")).toBe(0);
    expect(imports()).toBe(importsBefore + 1); // the passing re-import's row only: the refused one rolled back
  });
});

describe("claim links reach only the people of the events the organizer runs", () => {
  const TWO = "evt_02";
  const X = { id: "usr_org_two", email: "org-two@example.org", name: "Second Event Organizer" };

  /** A second event with its own people, run by X, an organizer who is not an administrator. */
  function secondEventRunByX(): Actor {
    const file = JSON.parse(exportFile(organizer(), EVENT, "fixtures.json").body) as FixtureFile;
    importEventFile(organizer(), {
      ...file,
      event: { ...file.event, id: TWO, name: "Second Hack 2026" },
      judges: file.judges.map((j) => ({ ...j, email: `two.${j.email}` })),
      teams: file.teams.map((t) => ({ ...t, members: t.members.map((m) => `two.${m}`) })),
    });
    ha.sqlite
      .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
      .run(X.id, X.email, X.name, NOW);
    addOrganizer(organizer(), TWO, { email: X.email });
    return actorIn(ha, X.id);
  }

  /** A judge of the fixture event with no password yet: the account the takeover wants. */
  const fixtureJudge = () =>
    one<{ id: string; email: string }>(
      ha,
      "SELECT u.id, u.email FROM users u JOIN user_roles r ON r.user_id = u.id " +
        "WHERE r.event_id = ? AND r.role = 'judge' AND u.password_hash IS NULL ORDER BY u.email LIMIT 1",
      EVENT,
    )!;

  it("an organizer gets no set-password link for someone who also belongs to an event they do not run", () => {
    const x = secondEventRunByX();
    const judge = fixtureJudge();
    // only an administrator can bring another event's judge in now (organizers.test.ts); the claim rule holds on its own too
    expect(addOrganizer(organizer(), TWO, { email: judge.email })).toMatchObject({ added: true });

    const { links, elsewhere } = makeClaimLinks(x, TWO);
    expect(links.map((l) => l.email)).not.toContain(judge.email);
    // left out: the judge, and the demo administrator who imported the second event (no password on purpose)
    expect(elsewhere.map((p) => p.email)).toEqual([judge.email, "organizer@example.org"].sort());
    expect(nOf(ha, "SELECT count(*) AS n FROM account_claims WHERE user_id IN (?, 'usr_organizer')", judge.id)).toBe(0);
    expect(countWithoutPassword(x, TWO)).toBe(links.length);
    expect(countBeyondReach(x, TWO)).toBe(2);

    // positive controls: the second event's own people still get links, and an administrator reaches everyone
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.email.startsWith("two."))).toBe(true);
    // an administrator reaches everyone (they can send anyone a reset link anyway), even a judge of an event they do not run
    ha.sqlite.prepare("DELETE FROM user_roles WHERE user_id = 'usr_organizer' AND event_id = ?").run(EVENT);
    expect(makeClaimLinks(organizer(), TWO).links.map((l) => l.email)).toContain(judge.email);
  });

  it("a link made while the person was the organizer's alone stops working once they also belong to another event", async () => {
    const x = secondEventRunByX();
    const [first, second] = makeClaimLinks(x, TWO).links;
    addOrganizer(organizer(), EVENT, { email: first!.email }); // the fixture event takes the first person on too

    expectHttpError(() => describeClaim(tokenOf(first!)), 410, "claim_out_of_reach");
    await expectHttpErrorAsync(() => claimAccount(tokenOf(first!), { password: "a long enough password" }), 410, "claim_out_of_reach");
    expect(nOf(ha, "SELECT count(*) AS n FROM users WHERE email = ? AND password_hash IS NULL", first!.email)).toBe(1);

    // positive control: a link for someone still only in the second event works
    const user = one<{ id: string }>(ha, "SELECT id FROM users WHERE email = ?", second!.email)!;
    expect(await claimAccount(tokenOf(second!), { password: "a long enough password" })).toEqual({ userId: user.id });
  });
});
