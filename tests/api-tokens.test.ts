import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { createApiToken, listApiTokens, revokeApiToken } from "@/server/dal/tokens";
import { getOverview } from "@/server/dal/overview";
import { actorForToken, API_TOKEN_PREFIX } from "@/server/session";
import { sha256 } from "@/server/util";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the tokens DAL and getOverview go through getDb()
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

/** A member of a team whose kept project is submitted (as tests/records.test.ts picks one). */
function anyParticipant() {
  const row = one<{ id: string }>(
    "SELECT tm.user_id AS id FROM team_members tm " +
      "JOIN projects p ON p.team_id = tm.team_id " +
      "WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = 'evt_01' LIMIT 1",
  );
  if (!row) throw new Error("no participant on a submitted team in the fixture");
  return row;
}

const tokenRow = (id: string) => one<Record<string, string | null>>("SELECT * FROM api_tokens WHERE id = ?", id)!;

describe("API tokens", () => {
  it("creating a token returns it once; the row stores only its hash and a short hint", () => {
    const participant = actorById(anyParticipant().id);
    const made = createApiToken(participant, { name: "Sync script" });

    expect(made.id).toMatch(/^tok_[a-z2-9]{12}$/);
    expect(made.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(made.name).toBe("Sync script");
    const ninetyDays = Date.now() + 90 * 86_400_000;
    expect(Math.abs(Date.parse(made.expiresAt!) - ninetyDays)).toBeLessThan(60_000);

    const row = tokenRow(made.id);
    expect(row.user_id).toBe(participant.userId);
    expect(row.name).toBe("Sync script");
    expect(row.revoked_at).toBeNull();
    expect(row.last_used_at).toBeNull();
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(made.token); // no column carries the token itself
    }
    expect(row.token_hash).toBe(sha256(made.token));
    expect(row.hint).toBe(made.token.slice(0, 10));
  });

  it("a token resolves to its creator's identity with sessionKind 'api', and stamps last_used_at", () => {
    const participant = actorById(anyParticipant().id);
    const made = createApiToken(participant, { name: "Sync script" });

    const tokenActor = actorForToken(h.db, made.token);
    expect(tokenActor).not.toBeNull();
    expect(tokenActor!.userId).toBe(participant.userId);
    expect(tokenActor!.sessionKind).toBe("api");
    expect(tokenActor!.roles).toEqual(participant.roles);

    const lastUsed = tokenRow(made.id).last_used_at;
    expect(lastUsed).not.toBeNull();
    expect(Date.parse(lastUsed!)).toBeGreaterThan(Date.now() - 60_000);

    expect(actorForToken(h.db, "dfk_nope")).toBeNull(); // known-bad: an unknown token resolves to nobody
  });

  it("permissions travel with the token: organizer reads the overview, a participant's token cannot", () => {
    const participantToken = createApiToken(actorById(anyParticipant().id), { name: "Participant token" });
    const pActor = actorForToken(h.db, participantToken.token);
    expectHttpError(() => getOverview(pActor, "evt_01"), 403, "not_an_organizer");

    const organizerToken = createApiToken(organizer(), { name: "Organizer token" });
    const oActor = actorForToken(h.db, organizerToken.token);
    const overview = getOverview(oActor, "evt_01");
    expect(overview.event.id).toBe("evt_01");
  });

  it("a token cannot manage tokens (403), and no session at all is 401", () => {
    const owner = actorById(anyParticipant().id);
    const made = createApiToken(owner, { name: "Sync script" });
    const tokenActor = actorForToken(h.db, made.token);

    const before = nOf("SELECT count(*) AS n FROM api_tokens");
    expectHttpError(() => createApiToken(tokenActor, { name: "More power" }), 403, "token_cannot_manage_tokens");
    expectHttpError(() => revokeApiToken(tokenActor, made.id), 403, "token_cannot_manage_tokens");
    expectHttpError(() => listApiTokens(tokenActor), 403, "token_cannot_manage_tokens");
    expect(nOf("SELECT count(*) AS n FROM api_tokens")).toBe(before); // nothing was minted

    expectHttpError(() => createApiToken(null, { name: "No session" }), 401, "unauthenticated");
    expectHttpError(() => revokeApiToken(null, made.id), 401, "unauthenticated");
    expectHttpError(() => listApiTokens(null), 401, "unauthenticated");
  });

  it("revoking kills the token, is idempotent without a second audit row, and another person's revoke is 404", () => {
    const owner = actorById(anyParticipant().id);
    const made = createApiToken(owner, { name: "Sync script" });

    expect(revokeApiToken(owner, made.id)).toEqual({ id: made.id });
    expect(actorForToken(h.db, made.token)).toBeNull();

    const revokesBefore = auditRows().filter((r) => r.action === "token.revoke").length;
    expect(revokeApiToken(owner, made.id)).toEqual({ id: made.id }); // already revoked: fine, no new row
    expect(auditRows().filter((r) => r.action === "token.revoke").length).toBe(revokesBefore);

    const other = actorById(anyParticipant().id);
    if (other.userId !== owner.userId) {
      expectHttpError(() => revokeApiToken(other, made.id), 404, "not_found");
    }
    expectHttpError(() => revokeApiToken(organizer(), made.id), 404, "not_found"); // even an organizer: not their token
  });

  it("expiry and validation: an expired token is nobody, days null means no expiry, junk is 422", () => {
    const owner = organizer();
    const made = createApiToken(owner, { name: "Clock test" });
    expect(actorForToken(h.db, made.token)).not.toBeNull(); // positive control before the clock work

    // The table's CHECK keeps expires_at after created_at, so park expiry one minute
    // after creation and read with a now just past that.
    const created = tokenRow(made.id).created_at!;
    const expiredAt = new Date(Date.parse(created) + 60_000).toISOString();
    h.sqlite.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(expiredAt, made.id);
    expect(actorForToken(h.db, made.token, new Date(Date.parse(expiredAt) + 1))).toBeNull();

    const forever = createApiToken(owner, { name: "Never expires", days: null });
    expect(forever.expiresAt).toBeNull();
    expect(tokenRow(forever.id).expires_at).toBeNull();
    expect(actorForToken(h.db, forever.token)).not.toBeNull();

    expectHttpError(() => createApiToken(owner, { name: "Bad days", days: 0 }), 422, "invalid");
    expectHttpError(() => createApiToken(owner, { name: "" }), 422, "invalid");
  });

  it("the audit log names the token by id only: no audit row carries the token", () => {
    const owner = actorById(anyParticipant().id);
    const made = createApiToken(owner, { name: "Sync script" });
    revokeApiToken(owner, made.id);

    const rows = auditRows();
    const created = rows.filter((r) => r.action === "token.create");
    const revoked = rows.filter((r) => r.action === "token.revoke");
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    for (const row of [created[0]!, revoked[0]!]) {
      expect(row.targetType).toBe("api_token");
      expect(row.targetId).toBe(made.id);
      expect(row.actorUserId).toBe(owner.userId);
    }
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(made.token);
    }
  });

  it("listApiTokens lists only the actor's own tokens, newest first, never the token or its hash", () => {
    const owner = actorById(anyParticipant().id);
    const older = createApiToken(owner, { name: "Older" });
    const newer = createApiToken(owner, { name: "Newer" });
    // Give "Older" a creation time an hour back so the ordering is decided, not incidental.
    h.sqlite.prepare("UPDATE api_tokens SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), older.id);
    const stranger = createApiToken(organizer(), { name: "Someone else's" });

    const listed = listApiTokens(owner);
    expect(listed.map((t) => t.id)).toEqual([newer.id, older.id]);
    expect(listed.map((t) => t.id)).not.toContain(stranger.id);
    expect(listed[0]!.name).toBe("Newer");
    expect(Object.keys(listed[0]!).sort()).toEqual(["createdAt", "expiresAt", "hint", "id", "lastUsedAt", "name", "revokedAt"].sort());
    for (const t of listed) {
      expect(t).not.toHaveProperty("token");
      expect(t).not.toHaveProperty("tokenHash");
    }
  });
});
