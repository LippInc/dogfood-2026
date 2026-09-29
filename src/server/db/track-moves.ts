import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "./client";
import { auditLog } from "./schema";

/** One organizer move of a project to another track after judges were assigned: ids, the reason, when. */
export type TrackMove = { projectId: string; fromTrackId: string; toTrackId: string; reason: string; at: string };

const text = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Every track move of an event, oldest first, from its audit log: the moves an import brought with a new event (made
 * on the portal the event came from, listed in the import's own row) and then each move made here
 * (project.track_moved rows). The audit log is the one place a move is kept, so the published run, the event's
 * export and the results all read it here.
 */
export function readTrackMoves(db: DbOrTx, eventId: string): TrackMove[] {
  const rows = db
    .select({ action: auditLog.action, projectId: auditLog.targetId, before: auditLog.before, after: auditLog.after, at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), inArray(auditLog.action, ["fixtures.import", "project.track_moved"])))
    .orderBy(asc(auditLog.id))
    .all();
  const moves: TrackMove[] = [];
  for (const r of rows) {
    if (r.action === "fixtures.import") {
      const brought = (r.after as { restored?: { trackMoves?: unknown } } | null)?.restored?.trackMoves;
      if (!Array.isArray(brought)) continue;
      for (const m of brought as Record<string, unknown>[]) {
        const [projectId, fromTrackId, toTrackId, reason, at] = [text(m.projectId), text(m.fromTrackId), text(m.toTrackId), text(m.reason), text(m.at)];
        if (projectId && fromTrackId && toTrackId && reason !== null && at) moves.push({ projectId, fromTrackId, toTrackId, reason, at });
      }
      continue;
    }
    const from = text((r.before as { trackId?: unknown } | null)?.trackId);
    const after = r.after as { trackId?: unknown; reason?: unknown } | null;
    const to = text(after?.trackId);
    if (!r.projectId || !from || !to) continue;
    moves.push({ projectId: r.projectId, fromTrackId: from, toTrackId: to, reason: text(after?.reason) ?? "", at: r.at });
  }
  return moves;
}
