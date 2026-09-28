import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { updateEventDetails } from "@/server/dal/organize";
import { requireEvent } from "@/server/dal/events";
import { issueAllRecords, issueOwnRecord, issueOwnRecordRequest, getRecord, keysDocument, listRecords, verifyRecord } from "@/server/dal/records";
import { competitionPlaces } from "@/lib/places";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the records DAL goes through getDb()
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

/** The judge with the most finished reviews, other than the flat-vector jdg_07 the publish sequence excludes. */
function topJudge() {
  const row = one<{ id: string; n: number }>(
    "SELECT judge_user_id AS id, count(*) AS n FROM assignments WHERE event_id = 'evt_01' AND status = 'done' AND judge_user_id <> 'jdg_07' GROUP BY judge_user_id ORDER BY n DESC LIMIT 1",
  );
  if (!row) throw new Error("no judge with a done assignment in the fixture");
  return row;
}

/** A member of a team whose kept project is submitted (duplicate copies do not earn certificates). */
function anyParticipant() {
  const row = one<{ id: string; projectId: string; title: string; team: string }>(
    "SELECT tm.user_id AS id, p.id AS projectId, p.title AS title, t.name AS team FROM team_members tm " +
      "JOIN projects p ON p.team_id = tm.team_id JOIN teams t ON t.id = tm.team_id " +
      "WHERE p.status = 'submitted' AND p.duplicate_of IS NULL AND tm.event_id = 'evt_01' LIMIT 1",
  );
  if (!row) throw new Error("no participant on a submitted team in the fixture");
  return row;
}

/** Settle the fixture's three decisions and publish, as tests/normalization-dal.test.ts does. */
function publish() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(organizer(), "evt_01");
}

type JudgeRecord = {
  format: string;
  kind: string;
  keyId: string;
  event: { id: string };
  person: { name: string };
  judging: { finishedReviews: number; tracks: string[] };
};
type ParticipantRecord = {
  kind: string;
  project: { title: string; team: string; track: string | null; awards: string[] };
};

describe("signed records and certificates", () => {
  it("before the results are published nobody can be issued a record, and none exists", () => {
    const judge = actorById(topJudge().id);
    const participant = actorById(anyParticipant().id);
    expectHttpError(() => issueOwnRecord(judge, "evt_01", "judge"), 403, "results_not_published");
    expectHttpError(() => issueOwnRecord(participant, "evt_01", "participant"), 403, "results_not_published");
    expect(nOf("SELECT count(*) AS n FROM signed_records")).toBe(0);
  });

  it("a judge's record is issued once: the same id on the second ask, exactly one record.issue audit row", () => {
    publish();
    const judge = actorById(topJudge().id);
    const first = issueOwnRecord(judge, "evt_01", "judge");
    expect(first.created).toBe(true);
    expect(first.id).toMatch(/^rec_[a-z2-9]{16}$/);

    const second = issueOwnRecord(judge, "evt_01", "judge");
    expect(second).toEqual({ id: first.id, created: false });

    const rows = auditRows().filter((r) => r.action === "record.issue");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(first.id);
  });

  it("a rename after publishing leaves the record as signed and the record's page says so; no rename, no note (positive control)", () => {
    publish();
    const { id } = issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");
    expect(getRecord(id).renamed).toBeNull();
    const e = requireEvent(h.db, "evt_01");
    const minute = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 16) : "");
    updateEventDetails(organizer(), "evt_01", {
      name: "Sample Hack 2026, renamed",
      description: e.description,
      submissionsOpenAt: minute(e.submissionsOpenAt),
      submissionsCloseAt: minute(e.submissionsCloseAt),
      judgingCloseAt: minute(e.judgingCloseAt),
      maxTeamSize: e.settings.maxTeamSize ?? 4,
    });
    const view = getRecord(id);
    expect((view.envelope.record as { event: { name: string } }).event.name).toBe("Sample Hack 2026");
    expect(view.event.name).toBe("Sample Hack 2026, renamed");
    expect(view.renamed).toEqual({ signed: "Sample Hack 2026", now: "Sample Hack 2026, renamed" });
    expect(view.verification.valid).toBe(true);
  });

  it("the stored record verifies against the portal's own key", () => {
    publish();
    const { id } = issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");
    const keyId = one<{ id: string }>("SELECT id FROM signing_keys")!.id;
    const view = getRecord(id);
    expect(view.verification).toEqual({ valid: true, keyId });
    expect(verifyRecord(view.envelope).valid).toBe(true);
  });

  it("known-bad: every tampered envelope fails, each with its own reason", () => {
    publish();
    const { id } = issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");
    const good = getRecord(id).envelope;

    const renamed = structuredClone(good);
    renamed.record.person = { ...(renamed.record.person as { name: string }), name: "Somebody Else Entirely" };
    expect(verifyRecord(renamed)).toMatchObject({ valid: false, reason: "bad_signature" });

    const bumped = structuredClone(good);
    (bumped.record.judging as { finishedReviews: number }).finishedReviews += 1;
    expect(verifyRecord(bumped)).toMatchObject({ valid: false, reason: "bad_signature" });

    const flipped = structuredClone(good);
    flipped.signature = (flipped.signature.startsWith("A") ? "B" : "A") + flipped.signature.slice(1);
    expect(verifyRecord(flipped)).toMatchObject({ valid: false, reason: "bad_signature" });

    const wrongKey = structuredClone(good);
    wrongKey.record.keyId = "key_nope";
    expect(verifyRecord(wrongKey)).toMatchObject({ valid: false, reason: "unknown_key" });

    expect(verifyRecord(null)).toMatchObject({ valid: false, reason: "malformed" });
    expect(verifyRecord({})).toMatchObject({ valid: false, reason: "malformed" });
    expect(verifyRecord({ record: "x", signature: "y" })).toMatchObject({ valid: false, reason: "malformed" });
  });

  it("a judge's record says what a CV would: the name, the event, the finished reviews — never an email or a score", () => {
    publish();
    const j = topJudge();
    const { id } = issueOwnRecord(actorById(j.id), "evt_01", "judge");
    const u = one<{ name: string; email: string }>("SELECT name, email FROM users WHERE id = ?", j.id)!;
    const record = getRecord(id).envelope.record as JudgeRecord;

    expect(record.format).toBe("dogfood-record/v1");
    expect(record.kind).toBe("judge");
    expect(record.event.id).toBe("evt_01");
    expect(record.person.name).toBe(u.name);
    expect(record.judging.finishedReviews).toBe(j.n); // the SQL count of this judge's done assignments

    const json = JSON.stringify(getRecord(id).envelope);
    expect(json).not.toContain(u.email);
    expect(json).not.toContain("score");
  });

  it("refusals: a participant is not a judge here, a judge off the teams gets no certificate, no session is 401, junk is 422", () => {
    const j = topJudge();
    const p = anyParticipant();
    const judge = actorById(j.id);
    const participant = actorById(p.id);

    expectHttpError(() => issueOwnRecord(participant, "evt_01", "judge"), 403, "not_a_judge_here");

    const judgeOnTeam = nOf("SELECT count(*) AS n FROM team_members WHERE event_id = 'evt_01' AND user_id = ?", j.id) > 0;
    if (!judgeOnTeam) {
      expectHttpError(() => issueOwnRecord(judge, "evt_01", "participant"), 403, "not_on_a_submitted_team");
    }

    expectHttpError(() => issueOwnRecord(null, "evt_01", "judge"), 401, "unauthenticated");
    expectHttpError(() => issueOwnRecordRequest(participant, "evt_01", { kind: "nope" }), 422, "invalid");
  });

  it("a certificate carries the project and the team, and the track winner's says 1st place", () => {
    publish();
    const p = anyParticipant();
    const { id } = issueOwnRecord(actorById(p.id), "evt_01", "participant");
    const record = getRecord(id).envelope.record as ParticipantRecord;
    expect(record.kind).toBe("participant");
    expect(record.project.title).toBe(p.title);
    expect(record.project.team).toBe(p.team);
    expect(Array.isArray(record.project.awards)).toBe(true);

    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("results should be published");
    const winner = results.tracks[0]!.rows[0]!; // the first track's top row
    const member = one<{ id: string }>(
      "SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE tm.event_id = 'evt_01' AND p.id = ? LIMIT 1",
      winner.projectId,
    )!;
    const { id: winnerId } = issueOwnRecord(actorById(member.id), "evt_01", "participant");
    const winnerRecord = getRecord(winnerId).envelope.record as ParticipantRecord;
    expect(winnerRecord.project.awards.some((a) => a.startsWith("1st place") || a.startsWith("Joint 1st place"))).toBe(true);
  });

  /** A member of the first project that holds the given place (not joint) in some track, once published. */
  function memberAtPlace(place: number) {
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("results should be published");
    for (const t of results.tracks) {
      const places = competitionPlaces(t.rows);
      const i = places.findIndex((p) => p.place === place && !p.joint);
      if (i < 0) continue;
      const projectId = t.rows[i]!.projectId;
      const m = one<{ id: string } | undefined>(
        "SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE tm.event_id = 'evt_01' AND p.id = ? LIMIT 1",
        projectId,
      );
      if (m) return { userId: m.id, track: t.name };
    }
    throw new Error(`no track has a lone place ${place} with a member`);
  }

  const details = (extra: Record<string, unknown>) => {
    const e = one<{ name: string; description: string; s: string; o: string | null; j: string | null }>(
      "SELECT name, description, submissions_close_at AS s, submissions_open_at AS o, judging_close_at AS j FROM events WHERE id = 'evt_01'",
    );
    return { name: e.name, description: e.description, submissionsCloseAt: e.s, submissionsOpenAt: e.o ?? "", judgingCloseAt: e.j ?? "", maxTeamSize: 4, ...extra };
  };

  it("by default only 1st to 3rd earn a certificate of achievement: a lone 4th place gets none", () => {
    publish();
    const fourth = memberAtPlace(4);
    const { id } = issueOwnRecord(actorById(fourth.userId), "evt_01", "participant");
    expect((getRecord(id).envelope.record as ParticipantRecord).project.awards).toEqual([]);
  });

  it("the organizer can set 5 places before publishing (audited): 4th place then earns one; after publishing the number is fixed (409)", () => {
    updateEventDetails(organizer(), "evt_01", details({ certificatePlaces: 5 }));
    const row = auditRows().filter((r) => r.action === "event.update").at(-1)!;
    expect(row.before).toMatchObject({ certificatePlaces: 3 });
    expect(row.after).toMatchObject({ certificatePlaces: 5 });
    publish();
    const fourth = memberAtPlace(4);
    const { id } = issueOwnRecord(actorById(fourth.userId), "evt_01", "participant");
    expect((getRecord(id).envelope.record as ParticipantRecord).project.awards).toEqual([`4th place, ${fourth.track}`]);
    expectHttpError(() => updateEventDetails(organizer(), "evt_01", details({ certificatePlaces: 2 })), 409, "results_published");
    // the same number, or leaving it out, is no change and still saves the rest
    expect(() => updateEventDetails(organizer(), "evt_01", details({ certificatePlaces: 5, name: "Sample Hack 2026 (final)" }))).not.toThrow();
    expect(() => updateEventDetails(organizer(), "evt_01", details({}))).not.toThrow();
  });

  it("the organizer issues everyone's records at once, only after publishing, and only the organizer can", () => {
    expectHttpError(() => issueAllRecords(organizer(), "evt_01"), 403, "results_not_published");
    publish();

    const judges = nOf(
      "SELECT count(DISTINCT judge_user_id) AS n FROM assignments WHERE event_id = 'evt_01' AND status = 'done'",
    );
    const members = nOf(
      "SELECT count(DISTINCT tm.user_id) AS n FROM team_members tm JOIN projects p ON p.team_id = tm.team_id " +
        "WHERE tm.event_id = 'evt_01' AND p.status = 'submitted' AND p.duplicate_of IS NULL",
    );
    expect(judges).toBeGreaterThan(0);
    expect(members).toBeGreaterThan(0);

    expect(issueAllRecords(organizer(), "evt_01")).toEqual({ judges, participants: members });
    expect(issueAllRecords(organizer(), "evt_01")).toEqual({ judges: 0, participants: 0 });
    expect(listRecords(organizer(), "evt_01")).toHaveLength(judges + members);

    expectHttpError(() => issueAllRecords(actorById(topJudge().id), "evt_01"), 403, "not_an_organizer");
  });

  it("the keys document publishes exactly the public half of the one key", () => {
    publish();
    issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");

    const doc = keysDocument();
    expect(doc.keys).toHaveLength(1);
    const key = doc.keys[0]!;
    expect(key.kty).toBe("OKP");
    expect(key.crv).toBe("Ed25519");
    expect(key.alg).toBe("EdDSA");
    expect(key.x).toHaveLength(43);

    const json = JSON.stringify(doc);
    expect(json).not.toContain('"d":');
    const row = one<{ private_pkcs8: string }>("SELECT private_pkcs8 FROM signing_keys")!;
    expect(json).not.toContain(row.private_pkcs8);
  });

  it("issuing records leaves the audit chain verifiable", () => {
    publish();
    issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");
    issueAllRecords(organizer(), "evt_01");
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("an independent check: canonical JSON with sorted keys, verified with plain node:crypto", () => {
    publish();
    const { id } = issueOwnRecord(actorById(topJudge().id), "evt_01", "judge");
    const envelope = getRecord(id).envelope;
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: keysDocument().keys[0]!.x }, format: "jwk" });

    // written here from the documented format, independently of src/server/util.ts
    const canonical = (value: unknown): string =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : value && typeof value === "object"
          ? `{${Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
              .join(",")}}`
          : JSON.stringify(value);

    const signature = Buffer.from(envelope.signature, "base64url");
    expect(crypto.verify(null, Buffer.from(canonical(envelope.record), "utf8"), key, signature)).toBe(true);

    const tampered = structuredClone(envelope.record);
    tampered.person = { ...(tampered.person as { name: string }), name: "Not The Judge" };
    expect(crypto.verify(null, Buffer.from(canonical(tampered), "utf8"), key, signature)).toBe(false);
  });
});

describe("the audit log anchor", () => {
  it("a record pins the log's newest entry when it was signed, inside the signature, and the published results pin their own entry", () => {
    publish();
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    const publishRow = auditRows().filter((r) => r.action === "results.publish").at(-1)!;
    expect(results.anchor).toEqual({ entry: publishRow.id, hash: publishRow.hash });

    const judge = actorById(topJudge().id);
    const { id } = issueOwnRecord(judge, "evt_01", "judge");
    // the newest entry at signing time: the one just before the record's own issue entry
    const rows = auditRows();
    const head = rows[rows.findIndex((r) => r.action === "record.issue" && r.targetId === id) - 1]!;
    const view = getRecord(id);
    expect((view.envelope.record as { auditLog?: unknown }).auditLog).toEqual({ entry: head.id, hash: head.hash });
    expect(view.anchor).toEqual({ entry: head.id, hash: head.hash, holds: true });
    expect(view.verification.valid).toBe(true);
    // the anchor is signed: changing it breaks the signature
    const forged = { ...view.envelope, record: { ...view.envelope.record, auditLog: { entry: head.id, hash: "0".repeat(64) } } };
    expect(verifyRecord(forged).valid).toBe(false);
  });

  it("a rewrite of the log up to the pinned entry shows on the record (known-bad: a log changed after issuing)", () => {
    publish();
    const judge = actorById(topJudge().id);
    const { id } = issueOwnRecord(judge, "evt_01", "judge");
    const pinned = getRecord(id).anchor!;
    // What someone with the database file could do: lift the append-only trigger and re-hash an entry.
    h.sqlite.exec("DROP TRIGGER audit_log_no_update");
    h.sqlite.prepare("UPDATE audit_log SET hash = ? WHERE id = ?").run("f".repeat(64), pinned.entry);
    expect(getRecord(id).anchor).toEqual({ ...pinned, holds: false });
    expect(getRecord(id).verification.valid).toBe(true); // the record itself is still genuine
  });
});
