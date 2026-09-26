import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import type { Tx } from "../db/client";
import { projects, teamMembers, teams, tracks } from "../db/schema";
import { ConflictError, ValidationError } from "../errors";
import { mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .url("must be a full URL, starting with https://")
  .or(z.literal(""))
  .optional()
  .transform((v) => (v ? v : null));

export const ProjectInput = z.object({
  title: z.string().trim().min(1, "a title is required").max(120),
  summary: z.string().trim().max(280).default(""),
  description: z.string().trim().max(20_000).default(""),
  trackId: z.string().trim().min(1, "choose a track"),
  repoUrl: optionalUrl,
  videoUrl: optionalUrl,
  liveUrl: optionalUrl,
  status: z.enum(["draft", "submitted"]).default("submitted"),
});
export type ProjectInput = z.input<typeof ProjectInput>;

export function teamOf(tx: Tx, userId: string, eventId: string) {
  return tx
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.eventId, eventId)))
    .get();
}

/**
 * Create the actor's team project. Refusals come first, in this order: no session
 * (401), not on a team in this event (403), submissions closed (403). Only then is
 * the body validated (422), so a closed event refuses whatever is sent.
 */
export function createProject(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow | undefined;
  let team: { id: string; name: string } | undefined;
  return mutate({
    actor,
    action: "project.create",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      team = actor ? teamOf(tx, actor.userId, event.id) : undefined;
      return { kind: "team_work", event: eventFacts(event), onTeam: Boolean(team) };
    },
    run: (tx) => {
      const parsed = ProjectInput.safeParse(body);
      if (!parsed.success) throw new ValidationError("The project is not valid.", z.flattenError(parsed.error).fieldErrors);
      const input = parsed.data;
      const e = event!;
      const t = team!;
      const track = tx
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.id, input.trackId), eq(tracks.eventId, e.id)))
        .get();
      if (!track) throw new ValidationError("The project is not valid.", { trackId: ["not a track of this event"] });
      const existing = tx.select({ id: projects.id }).from(projects).where(eq(projects.teamId, t.id)).get();
      if (existing) {
        throw new ConflictError("team_has_project", `Team ${t.name} already has project ${existing.id}; edit it instead.`);
      }
      const now = new Date().toISOString();
      const row = {
        id: newId("prj"),
        eventId: e.id,
        teamId: t.id,
        trackId: track.id,
        title: input.title,
        summary: input.summary,
        description: input.description,
        repoUrl: input.repoUrl,
        videoUrl: input.videoUrl,
        liveUrl: input.liveUrl,
        status: input.status,
        submittedAt: input.status === "submitted" ? now : null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(projects).values(row).run();
      return {
        result: row,
        audit: {
          action: input.status === "submitted" ? "project.submit" : "project.create",
          eventId: e.id,
          targetType: "project",
          targetId: row.id,
          after: { title: row.title, trackId: row.trackId, teamId: row.teamId, status: row.status },
        },
      };
    },
  });
}
