import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit";
import { authorize, type Actor } from "../authz";
import { getDb } from "../db/client";
import { FixtureSchema, importFixtures, type ImportReport } from "../db/import-fixtures";
import { events, userRoles } from "../db/schema";
import { AuthzError, ValidationError } from "../errors";
import { guardRead } from "../mutate";
import { canonicalJson, nowIso, sha256 } from "../util";

// Bulk import: an administrator uploads an event in the organizers' own fixture
// format (event, tracks, judges, teams, projects, scores), the format this portal
// also exports as fixtures.json. It goes through the same idempotent importer the
// portal boots with: a file imported twice changes nothing, and a file for an event
// that exists adds only what is new. The importer becomes an organizer of it.

export type EventImport = ImportReport & { eventSlug: string };

export function importEventFile(actor: Actor | null, body: unknown): EventImport {
  // Decided (and a refusal audited) before the file is read; decided again inside the import's transaction.
  guardRead(actor, "event.create", { kind: "platform" });
  const parsed = FixtureSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(`This is not an event file in the fixture format. ${z.prettifyError(parsed.error)}`);
  const fixture = parsed.data;
  const now = nowIso();
  const report = importFixtures(getDb(), fixture, {
    source: "upload",
    sha256: sha256(canonicalJson(body)),
    now,
    actor: { userId: actor!.userId, label: actor!.name },
    gate: () => {
      const decision = authorize(actor, "event.create", { kind: "platform" });
      if (!decision.ok) throw new AuthzError(decision);
    },
    after: (tx) => {
      const added = tx
        .insert(userRoles)
        .values({ userId: actor!.userId, eventId: fixture.event.id, role: "organizer", createdAt: now })
        .onConflictDoNothing()
        .run();
      if (added.changes) {
        appendAudit(
          tx,
          { actorUserId: actor!.userId, actorLabel: actor!.name, action: "event.organizer_added", eventId: fixture.event.id, targetType: "user", targetId: actor!.userId },
          now,
        );
      }
    },
  });
  const slug = getDb().select({ slug: events.slug }).from(events).where(eq(events.id, report.eventId)).get()?.slug ?? report.eventId;
  return { ...report, eventSlug: slug };
}
