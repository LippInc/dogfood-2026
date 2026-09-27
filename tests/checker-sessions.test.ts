import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import {
  checkerSessionsEnabled,
  demoModeRefusal,
  CHECKER_LABELS,
  checkerToken,
  DEMO_ORGANIZER,
  ensureDemoOrganizer,
  seedCheckerSessions,
  type CheckerIdentity,
} from "@/server/checker";
import { actorForToken, createLoginSession, hashPassword, verifyPassword } from "@/server/session";
import { sessions, teamMembers, userRoles, users } from "@/server/db/schema";
import { sha256 } from "@/server/util";

const NOW = "2026-09-26T12:00:00.000Z";

describe("checkerToken (pure)", () => {
  it("is deterministic for the same label and secret", () => {
    expect(checkerToken("judge_a", "s1")).toBe(checkerToken("judge_a", "s1"));
  });

  it("is plain letters and digits, prefixed per label", () => {
    for (const label of CHECKER_LABELS) {
      expect(checkerToken(label, "s1")).toMatch(/^[a-z0-9]+$/);
    }
    expect(checkerToken("organizer", "s1").startsWith("org")).toBe(true);
    expect(checkerToken("judge_a", "s1").startsWith("jda")).toBe(true);
    expect(checkerToken("judge_b", "s1").startsWith("jdb")).toBe(true);
    expect(checkerToken("participant", "s1").startsWith("prt")).toBe(true);
  });

  it("differs between labels and between secrets", () => {
    expect(new Set(CHECKER_LABELS.map((l) => checkerToken(l, "s1"))).size).toBe(4);
    for (const label of CHECKER_LABELS) {
      expect(checkerToken(label, "s1")).not.toBe(checkerToken(label, "s2"));
    }
  });
});

describe("passwords (argon2id)", () => {
  it("hashes with the required parameters and verifies only the right password", () => {
    const hash = hashPassword("correct horse");
    expect(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    expect(verifyPassword("correct horse", hash)).toBe(true);
    expect(verifyPassword("wrong horse", hash)).toBe(false);
    expect(verifyPassword("x", null)).toBe(false);
  });
});

describe("checker sessions (database)", () => {
  let h: Handle;
  let oldSeed: string | undefined;
  let oldSecret: string | undefined;

  beforeEach(() => {
    oldSeed = process.env.SEED_CHECKER_SESSIONS;
    oldSecret = process.env.DOGFOOD_SEED_SECRET;
    process.env.SEED_CHECKER_SESSIONS = "true";
    process.env.DOGFOOD_SEED_SECRET = "test-secret";

    h = openDatabase(":memory:");
    runMigrations(h, path.join(process.cwd(), "drizzle"));
    const { fixture, sha256: digest } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256: digest, now: NOW });
    ensureDemoOrganizer(h.db, "evt_01", NOW);
  });

  afterEach(() => {
    h.sqlite.close();
    if (oldSeed === undefined) delete process.env.SEED_CHECKER_SESSIONS;
    else process.env.SEED_CHECKER_SESSIONS = oldSeed;
    if (oldSecret === undefined) delete process.env.DOGFOOD_SEED_SECRET;
    else process.env.DOGFOOD_SEED_SECRET = oldSecret;
  });

  function seed(): CheckerIdentity[] {
    const result = seedCheckerSessions(h.db, "evt_01", NOW);
    if (!result.enabled) throw new Error("SEED_CHECKER_SESSIONS=true but seeding reported disabled");
    return result.identities;
  }

  const checkerSessionCount = () =>
    (h.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE kind = 'checker'").get() as { n: number }).n;

  it("picks the four identities from the fixture and each token resolves to the right actor", () => {
    const identities = seed();
    expect(identities.map((i) => i.label)).toEqual([...CHECKER_LABELS]);
    const byLabel = Object.fromEntries(identities.map((i) => [i.label, i]));

    expect(byLabel.judge_a?.userId).toBe("jdg_24"); // the fixture's busiest judge
    expect(byLabel.judge_b?.userId).toBe("jdg_26"); // the busiest judge sharing a track with judge_a
    expect(byLabel.organizer?.userId).toBe("usr_organizer");

    // the participant holds no judge role and IS a team member
    const participantId = byLabel.participant!.userId;
    const participantRoles = h.db.select().from(userRoles).where(eq(userRoles.userId, participantId)).all();
    expect(participantRoles.some((r) => r.role === "judge")).toBe(false);
    expect(h.db.select().from(teamMembers).where(eq(teamMembers.userId, participantId)).all().length).toBeGreaterThan(0);

    for (const identity of identities) {
      expect(actorForToken(h.db, identity.token)?.userId).toBe(identity.userId);
    }

    const judgeA = actorForToken(h.db, byLabel.judge_a!.token);
    expect(judgeA?.roles).toContainEqual({ eventId: "evt_01", role: "judge" });

    const participant = actorForToken(h.db, byLabel.participant!.token);
    expect(participant?.roles.some((r) => r.role === "judge")).toBe(false);

    const organizer = actorForToken(h.db, byLabel.organizer!.token);
    expect(organizer?.roles).toContainEqual({ eventId: "evt_01", role: "organizer" });
  });

  it("seeding a second time changes nothing: same tokens, no changes, exactly four checker sessions", () => {
    const first = seed();
    const again = seedCheckerSessions(h.db, "evt_01", NOW);
    expect(again.enabled && again.changed).toEqual([]);
    if (again.enabled) {
      expect(again.identities.map((i) => i.token)).toEqual(first.map((i) => i.token));
    }
    expect(checkerSessionCount()).toBe(4);
  });

  it("a deleted checker session comes back on the next seed with the same token", () => {
    const first = seed();
    const before = first.find((i) => i.label === "judge_b")!;
    h.sqlite.prepare("DELETE FROM sessions WHERE label = 'judge_b'").run();

    const again = seedCheckerSessions(h.db, "evt_01", NOW);
    expect(again.enabled && again.changed).toEqual(["judge_b"]);
    const after = again.enabled ? again.identities.find((i) => i.label === "judge_b") : undefined;
    expect(after?.token).toBe(before.token);
    expect(actorForToken(h.db, before.token)?.userId).toBe(before.userId);
    expect(checkerSessionCount()).toBe(4);
  });

  it("refuses demo mode on a non-local PUBLIC_URL with the public default secret, and removes an earlier boot's sessions (controls: a local address, or an own secret)", () => {
    const organizerToken = seed().find((i) => i.label === "organizer")!.token;
    const oldUrl = process.env.PUBLIC_URL;
    try {
      delete process.env.DOGFOOD_SEED_SECRET; // the public default
      process.env.PUBLIC_URL = "https://hack.example.org";
      expect(demoModeRefusal()).toMatch(/not a local address/);
      expect(checkerSessionsEnabled()).toBe(false);
      expect(seedCheckerSessions(h.db, "evt_01", NOW)).toMatchObject({ enabled: false, removed: 4 });
      expect(actorForToken(h.db, organizerToken)).toBeNull();
      expect(checkerSessionCount()).toBe(0);

      for (const local of ["http://localhost:8080", "http://127.0.0.1:8095", "http://[::1]:8080", "http://portal.localhost"]) {
        process.env.PUBLIC_URL = local;
        expect([local, checkerSessionsEnabled()]).toEqual([local, true]);
      }
      process.env.PUBLIC_URL = "https://hack.example.org";
      process.env.DOGFOOD_SEED_SECRET = "an operator's own secret";
      expect(checkerSessionsEnabled()).toBe(true);
      process.env.DOGFOOD_SEED_SECRET = "";
      process.env.PUBLIC_URL = "not a url";
      expect(checkerSessionsEnabled()).toBe(false);
    } finally {
      if (oldUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = oldUrl;
    }
  });

  it("SEED_CHECKER_SESSIONS=false removes every checker session and the old tokens stop resolving", () => {
    const first = seed();
    const organizerToken = first.find((i) => i.label === "organizer")!.token;

    process.env.SEED_CHECKER_SESSIONS = "false";
    const off = seedCheckerSessions(h.db, "evt_01", NOW);

    expect(off).toMatchObject({ enabled: false, removed: 4 });
    expect(actorForToken(h.db, organizerToken)).toBeNull();
    expect(checkerSessionCount()).toBe(0);
  });

  it("demo mode off also signs out the demo sign-ins and takes the demo organizer's admin; other people keep their sessions", () => {
    const first = seed();
    const judgeA = first.find((i) => i.label === "judge_a")!.userId;
    // What the demo sign-in buttons hand out: ordinary login sessions for the same identities.
    const demoJudge = createLoginSession(h.db, judgeA).token;
    const demoOrganizer = createLoginSession(h.db, DEMO_ORGANIZER.id).token;
    const bystanderId = h.db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.role, "judge"))
      .all()
      .map((r) => r.u)
      .find((u) => !first.some((i) => i.userId === u))!;
    const bystander = createLoginSession(h.db, bystanderId).token;
    const isAdmin = () => h.db.select({ a: users.isAdmin }).from(users).where(eq(users.id, DEMO_ORGANIZER.id)).get()!.a;
    expect(isAdmin()).toBe(true);

    process.env.SEED_CHECKER_SESSIONS = "false";
    const off = seedCheckerSessions(h.db, "evt_01", NOW);
    expect(off).toMatchObject({ enabled: false, removed: 4, demoted: true });
    expect(off.enabled ? 0 : off.signedOut).toBeGreaterThanOrEqual(2);
    expect(actorForToken(h.db, demoJudge)).toBeNull();
    expect(actorForToken(h.db, demoOrganizer)).toBeNull();
    expect(isAdmin()).toBe(false);
    // Positive control: someone who is not a demo identity stays signed in.
    expect(actorForToken(h.db, bystander)?.userId).toBe(bystanderId);

    // Demo mode back on: the demo organizer is an administrator again.
    process.env.SEED_CHECKER_SESSIONS = "true";
    ensureDemoOrganizer(h.db, "evt_01", NOW);
    expect(isAdmin()).toBe(true);
  });

  it("known-bad: a token with one character changed resolves to null", () => {
    const token = seed().find((i) => i.label === "judge_a")!.token;
    const flipped = token.endsWith("a") ? `${token.slice(0, -1)}b` : `${token.slice(0, -1)}a`;
    expect(flipped).not.toBe(token);
    expect(flipped).toHaveLength(token.length);
    expect(actorForToken(h.db, flipped)).toBeNull();
  });

  it("an expired login session resolves to null", () => {
    h.db
      .insert(sessions)
      .values({
        tokenHash: sha256("expiredtoken"),
        userId: "jdg_24",
        kind: "login",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-15T00:00:00.000Z",
      })
      .run();
    expect(actorForToken(h.db, "expiredtoken")).toBeNull();
  });
});
