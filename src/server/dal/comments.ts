import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { comments, projects, users } from "../db/schema";
import { NotFoundError, RateLimitedError } from "../errors";
import { mutate } from "../mutate";
import { LIMITS, takeAudited } from "../rate-limit";
import { newId } from "../util";
import { eventFacts, requireEvent } from "./events";
import { parse } from "./parse";

// Comments on a submitted project: anyone signed in may write one, a few per ten
// minutes, and delete their own; an organizer can hide one with a reason, which stays
// visible in its place ("hidden by the organizers: ...") so nothing disappears silently,
// and unhide it again. A hidden comment stays until the organizers unhide it: its author
// cannot delete it from under their reason.

export type CommentView = {
  id: string;
  author: string;
  body: string | null;
  createdAt: string;
  hidden: { reason: string } | null;
  mine: boolean;
};

export function listComments(actor: Actor | null, projectId: string): CommentView[] {
  return getDb()
    .select({
      id: comments.id,
      userId: comments.userId,
      author: users.name,
      body: comments.body,
      createdAt: comments.createdAt,
      hiddenAt: comments.hiddenAt,
      hiddenReason: comments.hiddenReason,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.projectId, projectId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all()
    .map((c) => ({
      id: c.id,
      author: c.author,
      body: c.hiddenAt ? null : c.body,
      createdAt: c.createdAt,
      hidden: c.hiddenAt ? { reason: c.hiddenReason ?? "" } : null,
      mine: actor?.userId === c.userId,
    }));
}

export const CommentInput = z.object({ body: z.string().trim().min(1, "write something first").max(2000, "at most 2,000 characters") });

export function postComment(actor: Actor | null, projectId: string, body: unknown) {
  const db = getDb();
  const project = db.select({ id: projects.id, eventId: projects.eventId, status: projects.status }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new NotFoundError("Project");
  if (actor) {
    const t = takeAudited(`comment:${actor.userId}`, LIMITS.comment, { userId: actor.userId, label: actor.name, eventId: project.eventId, what: "comment" });
    if (!t.ok) throw new RateLimitedError(t.retryAfter);
  }
  return mutate({
    actor,
    action: "comment.post",
    load: (tx) => ({
      kind: "project_comments",
      event: eventFacts(requireEvent(tx, project.eventId)),
      projectId: project.id,
      submitted: project.status === "submitted",
    }),
    run: (tx) => {
      const { body: text } = parse(CommentInput, body);
      const id = newId("cmt");
      tx.insert(comments).values({ id, eventId: project.eventId, projectId: project.id, userId: actor!.userId, body: text, createdAt: new Date().toISOString() }).run();
      return {
        result: { id },
        audit: { action: "comment.post", eventId: project.eventId, targetType: "project", targetId: project.id, after: { comment: id, chars: text.length } },
      };
    },
  });
}

export const HideInput = z.object({ reason: z.string().trim().min(3, "say why, in a few words").max(300) });

export function hideComment(actor: Actor | null, commentId: string, body: unknown) {
  let comment: typeof comments.$inferSelect;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const c = tx.select().from(comments).where(eq(comments.id, commentId)).get();
      if (!c) throw new NotFoundError("Comment");
      comment = c;
      return { kind: "event", event: eventFacts(requireEvent(tx, c.eventId)) };
    },
    run: (tx) => {
      const { reason } = parse(HideInput, body);
      if (comment.hiddenAt) return { result: { id: comment.id }, audit: null };
      tx.update(comments)
        .set({ hiddenAt: new Date().toISOString(), hiddenBy: actor!.userId, hiddenReason: reason })
        .where(and(eq(comments.id, comment.id)))
        .run();
      return {
        result: { id: comment.id },
        audit: { action: "comment.hide", eventId: comment.eventId, targetType: "project", targetId: comment.projectId, after: { comment: comment.id, reason } },
      };
    },
  });
}

/** The author deletes their own comment, for good; the audit row keeps its id and length, not its words. */
export function deleteComment(actor: Actor | null, commentId: string) {
  let comment: typeof comments.$inferSelect;
  return mutate({
    actor,
    action: "comment.delete",
    load: (tx) => {
      const c = tx.select().from(comments).where(eq(comments.id, commentId)).get();
      if (!c) throw new NotFoundError("Comment");
      comment = c;
      return { kind: "comment", event: eventFacts(requireEvent(tx, c.eventId)), commentId: c.id, authorId: c.userId, hidden: Boolean(c.hiddenAt) };
    },
    run: (tx) => {
      tx.delete(comments).where(eq(comments.id, comment.id)).run();
      return {
        result: { id: comment.id, deleted: true },
        audit: { action: "comment.deleted", eventId: comment.eventId, targetType: "project", targetId: comment.projectId, before: { comment: comment.id, chars: comment.body.length } },
      };
    },
  });
}

/** An organizer shows a hidden comment again; the row keeps the reason it was hidden with. */
export function unhideComment(actor: Actor | null, commentId: string) {
  let comment: typeof comments.$inferSelect;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const c = tx.select().from(comments).where(eq(comments.id, commentId)).get();
      if (!c) throw new NotFoundError("Comment");
      comment = c;
      return { kind: "event", event: eventFacts(requireEvent(tx, c.eventId)) };
    },
    run: (tx) => {
      if (!comment.hiddenAt) return { result: { id: comment.id }, audit: null };
      tx.update(comments).set({ hiddenAt: null, hiddenBy: null, hiddenReason: null }).where(eq(comments.id, comment.id)).run();
      return {
        result: { id: comment.id },
        audit: { action: "comment.unhide", eventId: comment.eventId, targetType: "project", targetId: comment.projectId, before: { comment: comment.id, reason: comment.hiddenReason } },
      };
    },
  });
}
