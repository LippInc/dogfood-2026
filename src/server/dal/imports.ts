import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit";
import { authorize, type Actor } from "../authz";
import { getDb } from "../db/client";
import { FixtureSchema, importFixtures, type ImportReport } from "../db/import-fixtures";
import { isPublishedRefusal } from "../db/triggers";
import { events, userRoles } from "../db/schema";
import { AuthzError, ConflictError, ValidationError } from "../errors";
import { guardRead } from "../mutate";
import { canonicalJson, nowIso, sha256 } from "../util";
import { formatUtc } from "@/lib/format";

// Bulk import: an administrator uploads an event in the organizers' own fixture
// format (event, tracks, judges, teams, projects, scores), the format this portal
// also exports as fixtures.json. It goes through the same idempotent importer the
// portal boots with: a file imported twice changes nothing, and a file for an event
// that exists adds only what is new, for that event's organizers and only until its
// results are published. The importer of a new event becomes its organizer. File ids
// that another event already holds are renamed for this event (the report lists them).

export type EventImport = ImportReport & { eventSlug: string };

/**
 * The largest event file the import takes, in bytes. The portal's own fixtures.json export
 * of a big event must fit: with every field at its longest (a 4,000-character review note,
 * 16 criteria, a project's six gallery pictures and eight tags, a team of 20), 64 MB holds an event of
 * 1,000 projects and 8,000 reviews, or 5,000 when every review also carries a 4,000-character private
 * note (tests/import-size.test.ts measures the exporter's worst case); ballots and comments take room of
 * their own. Only POST /api/imports takes a file this large: the proxy leaves that route
 * out and it reads the body itself (src/app/api/imports/route.ts), so the global limits on
 * server actions and the proxy (next.config.ts) stay small.
 */
export const MAX_EVENT_FILE_BYTES = 64_000_000;
export const EVENT_FILE_TOO_LARGE =
  "Event files are limited to 64 MB, room for an event of 1,000 projects and 8,000 reviews with every field at its longest (5,000 when each review also carries the longest private note), before its ballots and comments.";

/** Refuses (and audits) a caller who may not import, before the file is read: nobody else makes the server buffer one. */
export function guardImport(actor: Actor | null) {
  guardRead(actor, "event.create", { kind: "platform" });
}

/** Plain words for an organizer: a file that is no JSON object at all, or the first fields that are wrong. */
function whatIsWrong(error: z.ZodError): string {
  if (error.issues.some((i) => i.path.length === 0)) return "the file is not a JSON object with an event in it (export fixtures.json from an event to see the format)";
  const shown = error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`);
  return shown.join("; ") + (error.issues.length > 3 ? `; and ${error.issues.length - 3} more` : "");
}

type Deadlines = { submissionsCloseAt: string; judgingCloseAt: string | null };

/**
 * A file for an event that is here keeps that event's deadlines as its forms do (authz.ts: project.create, review.save),
 * by the server's clock: no project once submissions have closed, and no review (an assignment, a score, a value or
 * feedback) once judging has closed. It is refused whole, 409, naming the deadline. A new event's file is its history
 * and comes in whole, whatever its dates.
 */
function refuseLateAdditions(event: Deadlines, report: ImportReport, now: number) {
  const projects = report.inserted.projects;
  if (projects > 0 && now >= Date.parse(event.submissionsCloseAt)) {
    throw new ConflictError(
      "submissions_closed",
      `Submissions to this event closed at ${formatUtc(event.submissionsCloseAt)}, so an import can no longer add a project to it, as the project form cannot (this file adds ${projects === 1 ? "one" : projects}). Nothing was imported.`,
    );
  }
  const reviews = report.added.reviews.length;
  if (reviews > 0 && event.judgingCloseAt && now >= Date.parse(event.judgingCloseAt)) {
    throw new ConflictError(
      "judging_closed",
      `Judging in this event closed at ${formatUtc(event.judgingCloseAt)}, so an import can no longer add a review, a score or feedback to it, as the judging console cannot (this file adds to ${reviews === 1 ? "one review" : `${reviews} reviews`}). Nothing was imported.`,
    );
  }
}

export function importEventFile(actor: Actor | null, body: unknown): EventImport {
  // Decided (and a refusal audited) before the file is read; decided again inside the import's transaction.
  guardRead(actor, "event.create", { kind: "platform" });
  const parsed = FixtureSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(`This is not an event file in the fixture format: ${whatIsWrong(parsed.error)}.`);
  const fixture = parsed.data;
  const now = nowIso();
  // A file for an event that exists extends it only for that event's own organizers
  // (an administrator is not one by being an administrator), and never once its
  // results are published.
  const existing = getDb().select().from(events).where(eq(events.id, fixture.event.id)).get();
  if (existing) guardRead(actor, "event.manage", { kind: "event", event: existing }, new Date(), "write"); // an import changes the event
  let published = false;
  let here: Deadlines | null = null;
  const refuse = () =>
    new ConflictError(
      "results_published",
      "This event's results are published, so an import can no longer add to it. Import the file as a new event (give it an event id of its own).",
    );
  const run = (opts: Parameters<typeof importFixtures>[2]) => {
    try {
      return importFixtures(getDb(), fixture, opts);
    } catch (err) {
      // a review, a criterion or an assignment for the published event: the database refused it (src/server/db/triggers.ts)
      if (isPublishedRefusal(err)) throw refuse();
      throw err;
    }
  };
  const report = run({
    source: "upload",
    sha256: sha256(canonicalJson(body)),
    now,
    actor: { userId: actor!.userId, label: actor!.name },
    gate: (tx) => {
      const decision = authorize(actor, "event.create", { kind: "platform" });
      if (!decision.ok) throw new AuthzError(decision);
      const event = tx.select().from(events).where(eq(events.id, fixture.event.id)).get();
      if (event) {
        const manage = authorize(actor, "event.manage", { kind: "event", event });
        if (!manage.ok) throw new AuthzError(manage);
        published = event.resultsPublishedAt !== null;
        here = { submissionsCloseAt: event.submissionsCloseAt, judgingCloseAt: event.judgingCloseAt };
      }
    },
    after: (tx, r) => {
      if (published && Object.values(r.inserted).some((n) => n > 0)) throw refuse();
      if (here) refuseLateAdditions(here, r, Date.parse(now));
      if (r.inserted.events === 0) return; // the organizers of an event that was already here stay as they are
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
