import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { unauthenticated, type Actor } from "../authz";
import type { Tx } from "../db/client";
import { projects, teamMembers } from "../db/schema";
import { AuthzError, ConflictError, HttpError, NotFoundError } from "../errors";
import { mutate } from "../mutate";
import { MAX_GALLERY_IMAGES } from "../project-limits";
import { discardUpload, MAX_IMAGE_BYTES, redrawImage, shownElsewhere, sniffImage, storeUpload } from "../uploads";
import { HideInput } from "./comments";
import { eventFacts, requireEvent } from "./events";
import { parse } from "./parse";
import { checkGalleryUploads, droppedGalleryUploads, galleryList } from "./projects";

// A project's picture, uploaded by its team. The same rule as editing the project (project.edit:
// its team's members, while submissions are open), decided in the one transaction with the change
// and its audit row. As for every edit, the refusal comes first: only then are the size and the kind
// checked and the picture drawn again (outside any transaction, since drawing it takes a moment), and
// the rule is checked once more in the transaction that writes the file and the change; if anything
// after the write fails, the file is removed again, so a refused or failed upload leaves nothing. The
// picture it replaces, when that was an upload too and no other project shows it, is removed after the commit.

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
      shared = Boolean(before && shownElsewhere(tx, before, p.id));
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

/**
 * Every upload's checks, in their order: no session (401), then the write's own rule in a transaction that changes
 * nothing (403, audited; `also` adds the upload's own refusals, such as a full gallery), and only then the size and
 * the kind. The picture comes back drawn again from its pixels, so nothing else in the file is published (a phone
 * photo would give where it was taken).
 */
async function drawnPicture(actor: Actor | null, projectId: string, bytes: Uint8Array, also?: (p: typeof projects.$inferSelect) => void): Promise<Uint8Array> {
  // no session is a 401 whatever was sent, before the bytes are looked at (the route does not read a body for it)
  if (!actor) throw new AuthzError(unauthenticated);
  const into: { project?: typeof projects.$inferSelect } = {};
  mutate({
    actor,
    action: "project.edit",
    load: teamWork(actor, projectId, into),
    run: () => {
      also?.(into.project!);
      return { result: null, audit: null };
    },
  });
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "The image is over 8 MB. Save a smaller one and try again.");
  if (!sniffImage(bytes)) throw new HttpError(415, "unsupported_image", "Only PNG, JPEG or WebP images can be uploaded.");
  const drawn = await redrawImage(bytes);
  if (!drawn.ok) {
    if (drawn.why === "too_many_pixels") throw new HttpError(413, "image_too_large", "The image is over 50 megapixels. Save a smaller one and try again.");
    throw new HttpError(415, "unsupported_image", "The image file is damaged. Save it again as PNG, JPEG or WebP and try again.");
  }
  return drawn.bytes;
}

/** Upload a team's project picture: PNG, JPEG or WebP, told by its bytes, at most 8 MB; what is stored is the picture redrawn (redrawImage). */
export async function setProjectImage(actor: Actor | null, projectId: string, bytes: Uint8Array) {
  const drawn = { bytes: await drawnPicture(actor, projectId, bytes) };
  let stored: string | null = null;
  try {
    // checked again with the write: submissions may have closed while the picture was drawn
    return setThumbnail(actor, projectId, () => {
      stored = storeUpload(drawn.bytes, "webp");
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

/**
 * An organizer takes a project's picture down, uploaded or linked, at any time, with a reason for the
 * audit log, as a comment is hidden: the portal now hosts pictures, so the people who run the event
 * can remove one that should not be there. An uploaded file goes with it, unless another project shows it.
 */
export function takeDownProjectImage(actor: Actor | null, projectId: string, body: unknown) {
  let project: typeof projects.$inferSelect;
  let before: string | null = null;
  let shared = false;
  const result = mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const p = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!p) throw new NotFoundError("Project");
      project = p;
      return { kind: "event", event: eventFacts(requireEvent(tx, p.eventId)) };
    },
    run: (tx) => {
      const { reason } = parse(HideInput, body);
      before = project.thumbnailUrl;
      if (!before) return { result: { id: project.id, thumbnailUrl: null }, audit: null };
      shared = shownElsewhere(tx, before, project.id);
      tx.update(projects).set({ thumbnailUrl: null, updatedAt: new Date().toISOString() }).where(eq(projects.id, project.id)).run();
      return {
        result: { id: project.id, thumbnailUrl: null },
        audit: { action: "project.image_taken_down", eventId: project.eventId, targetType: "project", targetId: project.id, before: { thumbnailUrl: before }, after: { thumbnailUrl: null, reason } },
      };
    },
  });
  if (!shared) discardUpload(before);
  return result;
}

// The project's image gallery: up to MAX_GALLERY_IMAGES images shown on its project page, each uploaded here
// (through the picture's own checks and redraw, above) or linked on the team's own host. The team adds, removes and
// reorders them under the same rule as any edit (project.edit), each change one audited transaction; an organizer
// takes one down at any time with a reason. A removed upload's file goes after the commit unless another project shows it.

const galleryFull = () =>
  new ConflictError("gallery_full", `The gallery holds ${MAX_GALLERY_IMAGES} images, as many as it can. Remove one to add another.`);

/** Upload an image to the end of the project's gallery: the same kinds, limits and redraw as the picture; 409 gallery_full when it holds MAX_GALLERY_IMAGES. */
export async function addGalleryImage(actor: Actor | null, projectId: string, bytes: Uint8Array) {
  // a full gallery is refused before the picture is drawn, and again as it is written
  const drawn = await drawnPicture(actor, projectId, bytes, (p) => {
    if (p.galleryUrls.length >= MAX_GALLERY_IMAGES) throw galleryFull();
  });
  let stored: string | null = null;
  const into: { project?: typeof projects.$inferSelect } = {};
  try {
    // checked again with the write: submissions may have closed, or a teammate filled the gallery, while it was drawn
    return mutate({
      actor,
      action: "project.edit",
      load: teamWork(actor, projectId, into),
      run: (tx) => {
        const p = into.project!;
        if (p.galleryUrls.length >= MAX_GALLERY_IMAGES) throw galleryFull();
        stored = storeUpload(drawn, "webp");
        const url = `/uploads/${stored}`;
        const galleryUrls = [...p.galleryUrls, url];
        tx.update(projects).set({ galleryUrls, updatedAt: new Date().toISOString() }).where(eq(projects.id, p.id)).run();
        return {
          result: { id: p.id, url, galleryUrls },
          audit: { action: "project.gallery", eventId: p.eventId, targetType: "project", targetId: p.id, before: { galleryUrls: p.galleryUrls }, after: { galleryUrls } },
        };
      },
    });
  } catch (err) {
    discardUpload(stored);
    throw err;
  }
}

/**
 * The gallery's new list: its images in a new order, fewer of them, or a linked image added. `expected`, when sent, is
 * the list the caller last saw: a gallery that changed since (a teammate's upload) is 409 gallery_changed, so a stale
 * page never removes, and deletes, an image it never showed.
 */
export const GalleryInput = z.object({
  galleryUrls: galleryList,
  expected: z.array(z.string()).max(MAX_GALLERY_IMAGES * 2).optional(),
});

/** Set the gallery's list (reorder, remove, add a link). Uploads in it must be ones the gallery holds already. */
export function setGallery(actor: Actor | null, projectId: string, body: unknown) {
  const into: { project?: typeof projects.$inferSelect } = {};
  let dropped: string[] = [];
  const result = mutate({
    actor,
    action: "project.edit",
    load: teamWork(actor, projectId, into),
    run: (tx) => {
      const p = into.project!;
      const { galleryUrls, expected } = parse(GalleryInput, body, "The gallery is not valid.");
      if (expected && JSON.stringify(expected) !== JSON.stringify(p.galleryUrls))
        throw new ConflictError("gallery_changed", "The gallery changed since this page loaded, perhaps on a teammate's screen. Reload the page to see it, then try again.");
      checkGalleryUploads(galleryUrls, p.galleryUrls);
      if (JSON.stringify(galleryUrls) === JSON.stringify(p.galleryUrls)) return { result: { id: p.id, galleryUrls }, audit: null };
      dropped = droppedGalleryUploads(tx, p.galleryUrls, galleryUrls, p.id);
      tx.update(projects).set({ galleryUrls, updatedAt: new Date().toISOString() }).where(eq(projects.id, p.id)).run();
      return {
        result: { id: p.id, galleryUrls },
        audit: { action: "project.gallery", eventId: p.eventId, targetType: "project", targetId: p.id, before: { galleryUrls: p.galleryUrls }, after: { galleryUrls } },
      };
    },
  });
  for (const u of dropped) discardUpload(u);
  return result;
}

/** An organizer's take-down: the picture (no galleryUrl) or the gallery image at galleryUrl, with a reason. */
export const TakeDownInput = HideInput.extend({ galleryUrl: z.string().trim().min(1).max(500).optional() });

/**
 * An organizer takes one image out of a project's gallery, uploaded or linked, at any time, with a reason for the
 * audit log, as the picture is taken down. An uploaded file goes with it, unless another project shows it.
 */
export function takeDownGalleryImage(actor: Actor | null, projectId: string, body: unknown) {
  let project: typeof projects.$inferSelect;
  let gone: string | null = null;
  const result = mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const p = tx.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!p) throw new NotFoundError("Project");
      project = p;
      return { kind: "event", event: eventFacts(requireEvent(tx, p.eventId)) };
    },
    run: (tx) => {
      const { reason, galleryUrl } = parse(TakeDownInput.required({ galleryUrl: true }), body);
      if (!project.galleryUrls.includes(galleryUrl)) throw new NotFoundError("That image in the project's gallery");
      const galleryUrls = project.galleryUrls.filter((u) => u !== galleryUrl);
      gone = droppedGalleryUploads(tx, project.galleryUrls, galleryUrls, project.id)[0] ?? null;
      tx.update(projects).set({ galleryUrls, updatedAt: new Date().toISOString() }).where(eq(projects.id, project.id)).run();
      return {
        result: { id: project.id, galleryUrls },
        audit: {
          action: "project.gallery_image_taken_down",
          eventId: project.eventId,
          targetType: "project",
          targetId: project.id,
          before: { galleryUrls: project.galleryUrls },
          after: { galleryUrls, removed: galleryUrl, reason },
        },
      };
    },
  });
  discardUpload(gone);
  return result;
}
