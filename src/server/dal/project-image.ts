import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { unauthenticated, type Actor } from "../authz";
import type { Tx } from "../db/client";
import { projects, teamMembers } from "../db/schema";
import { AuthzError, HttpError, NotFoundError } from "../errors";
import { mutate } from "../mutate";
import { discardUpload, MAX_IMAGE_BYTES, sniffImage, storeUpload } from "../uploads";
import { eventFacts, requireEvent } from "./events";

// A project's picture, uploaded by its team. The same rule as editing the project (project.edit:
// its team's members, while submissions are open), decided in the one transaction with the change
// and its audit row. As for every edit, the refusal comes first: only then are the size and the kind
// checked and the file written, inside the transaction; if anything after the write fails, the file
// is removed again, so a refused or failed upload leaves nothing. The picture it replaces, when that
// was an upload too and no other project shows it, is removed after the commit.

function teamWork(actor: Actor | null, projectId: string, into: { project?: typeof projects.$inferSelect }) {
  return (tx: Tx) => {
    const p = tx.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) throw new NotFoundError("Project");
    into.project = p;
    const event = requireEvent(tx, p.eventId);
    const onTeam = actor
      ? Boolean(tx.select({ t: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.teamId, p.teamId), eq(teamMembers.userId, actor.userId))).get())
      : false;
    return { kind: "team_work" as const, event: eventFacts(event), onTeam };
  };
}

function setThumbnail(actor: Actor | null, projectId: string, next: (() => string) | null) {
  const into: { project?: typeof projects.$inferSelect } = {};
  let before: string | null = null;
  let shared = false;
  const result = mutate({
    actor,
    action: "project.edit",
    load: teamWork(actor, projectId, into),
    run: (tx) => {
      const p = into.project!;
      before = p.thumbnailUrl;
      // a file another project still shows is kept, however that project came to hold its address
      shared = Boolean(before && tx.select({ id: projects.id }).from(projects).where(and(eq(projects.thumbnailUrl, before), ne(projects.id, p.id))).get());
      const thumbnailUrl = next ? next() : null;
      const now = new Date().toISOString();
      tx.update(projects).set({ thumbnailUrl, updatedAt: now }).where(eq(projects.id, p.id)).run();
      return {
        result: { id: p.id, thumbnailUrl },
        audit: { action: "project.image", eventId: p.eventId, targetType: "project", targetId: p.id, before: { thumbnailUrl: before }, after: { thumbnailUrl } },
      };
    },
  });
  if (before !== result.thumbnailUrl && !shared) discardUpload(before);
  return result;
}

/** Upload a team's project picture: PNG, JPEG or WebP, told by its bytes, at most 2 MB. */
export function setProjectImage(actor: Actor | null, projectId: string, bytes: Uint8Array) {
  // no session is a 401 whatever was sent, before the bytes are looked at (the route does not count a body for it)
  if (!actor) throw new AuthzError(unauthenticated);
  let stored: string | null = null;
  try {
    return setThumbnail(actor, projectId, () => {
      if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "The image is over 2 MB. Save a smaller one (1600 pixels wide is plenty) and try again.");
      const kind = sniffImage(bytes);
      if (!kind) throw new HttpError(415, "unsupported_image", "Only PNG, JPEG or WebP images can be uploaded.");
      stored = storeUpload(bytes, kind);
      return `/uploads/${stored}`;
    }) as { id: string; thumbnailUrl: string };
  } catch (err) {
    discardUpload(stored);
    throw err;
  }
}

/** Take the project's picture away; an uploaded one's file goes with it. */
export function removeProjectImage(actor: Actor | null, projectId: string) {
  return setThumbnail(actor, projectId, null);
}
