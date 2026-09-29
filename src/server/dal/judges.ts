import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { sortByName } from "@/lib/names";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignmentRuns, assignments, events, judgeInvites, judgeTracks, projects, scores, tracks, userRoles, users, auditLog } from "../db/schema";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "../errors";
import { formatUtc } from "@/lib/format";
import type { FlatFlag } from "../judging/flat";
import { guardRead, mutate } from "../mutate";
import { newId, newSecret, sha256 } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { inJudgeTracks, judgeSet, type ActiveOverride } from "./judging";
import { parse } from "./parse";

// Judges join an event by invitation link: the organizer names the tracks, shares
// the link (the portal mails it too when email is on and the invitation names an
// address), and whoever opens it signed in becomes a judge for those tracks. A
// link made for an email address only works for that address. Links are
// single-use; only their SHA-256 is stored.

export const InviteInput = z.object({
  name: z.string().trim().max(80).default(""),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => v === "" || z.email().safeParse(v).success, "enter an email address, or leave it empty for an open link")
    .default(""),
  trackIds: z.array(z.string().min(1)).min(1, "choose at least one track"),
});

export const TrackIds = z.object({ trackIds: z.array(z.string().min(1)).min(1, "choose at least one track") });

function eventTrackIds(db: DbOrTx, eventId: string): Set<string> {
  return new Set(db.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => t.id));
}

function checkTracks(db: DbOrTx, eventId: string, ids: string[]): string[] {
  const known = eventTrackIds(db, eventId);
  const unique = [...new Set(ids)];
  if (unique.some((id) => !known.has(id))) throw new ValidationError("Check the highlighted fields.", { trackIds: ["a chosen track is not in this event"] });
  return unique.sort();
}

export function isJudgeIn(db: DbOrTx, userId: string, eventId: string): boolean {
  return Boolean(
    db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .get(),
  );
}

/**
 * An address holds at most one open invitation per event: a new one for the same address (sent again after a
 * lost mail, a double click, a replayed form) replaces the open one, which stops working, so an event never
 * collects several live links for one person. Returns the audit rows of the replaced ones (each a revocation).
 */
function replaceOpenInvites(tx: DbOrTx, eventId: string, email: string, now: string, replacedBy: string) {
  const open = tx
    .select({ id: judgeInvites.id })
    .from(judgeInvites)
    .where(and(eq(judgeInvites.eventId, eventId), eq(judgeInvites.email, email), isNull(judgeInvites.acceptedAt), isNull(judgeInvites.revokedAt)))
    .all();
  for (const row of open) tx.update(judgeInvites).set({ revokedAt: now }).where(eq(judgeInvites.id, row.id)).run();
  return open.map((row) => ({ action: "judge.invite_revoke", eventId, targetType: "judge_invite", targetId: row.id, after: { replacedBy } }));
}

/**
 * Whether a revoked invitation was replaced by a newer one for the same address (replaceOpenInvites), read from the
 * audit row written with the revocation, which names the replacement; false when an organizer revoked it by hand.
 */
function wasReplaced(db: DbOrTx, invite: { id: string; eventId: string }): boolean {
  const row = db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, invite.eventId), eq(auditLog.action, "judge.invite_revoke"), eq(auditLog.targetType, "judge_invite"), eq(auditLog.targetId, invite.id)))
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  return typeof (row?.after as { replacedBy?: unknown } | null | undefined)?.replacedBy === "string";
}

/** A link a newer invitation to the same address replaced: said as such (410 invite_replaced), not as a link never made. */
const inviteReplaced = () =>
  new HttpError(410, "invite_replaced", "A newer invitation replaced this link. Use the link in the newest invitation mail, or ask the organizer for a new one.");

/** The organizer makes an invitation link. The code is returned once and never stored. */
export function inviteJudge(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const input = parse(InviteInput, body);
      const trackIds = checkTracks(tx, event.id, input.trackIds);
      const email = input.email || null;
      if (email) {
        const existing = tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
        if (existing && isJudgeIn(tx, existing.id, event.id)) {
          throw new ConflictError("already_a_judge", `${email} is already a judge in this event.`);
        }
      }
      const id = newId("jinv");
      const code = newSecret(18);
      const now = new Date().toISOString();
      const replaced = email ? replaceOpenInvites(tx, event.id, email, now, id) : [];
      tx.insert(judgeInvites)
        .values({ id, eventId: event.id, codeHash: sha256(code), name: input.name, email, trackIds, createdAt: now, createdBy: actor!.userId })
        .run();
      return {
        result: { id, code, path: `/judge-invite/${code}`, email, replaced: replaced.length },
        // The code is a credential: the audit row names the invitation, never the code.
        audit: [...replaced, { action: "judge.invite", eventId: event.id, targetType: "judge_invite", targetId: id, after: { name: input.name, email, trackIds } }],
      };
    },
  });
}

export const MAX_BATCH_INVITES = 200;

export const BatchInviteInput = z.object({
  /** one judge per line: "name, email", "email", or "name" alone (an open link); a third field names the line's own tracks, separated by ";" */
  lines: z.string().max(40_000),
  /** the tracks of every line that names none of its own */
  trackIds: z.array(z.string().min(1)).default([]),
});

export type BatchLine = { line: number; name: string; email: string | null; trackIds: string[] };
export type BatchInvite = { id: string; code: string; path: string; name: string; email: string | null; line: number };
/** replaced: the addresses whose open invitation a line of the list replaced (the older link stopped working). */
export type BatchResult = { invites: BatchInvite[]; skipped: { line: number; email: string; reason: string }[]; replaced: string[] };

/**
 * Read a pasted list, one judge per line, in the shapes people paste: "Name <email>" as an
 * email client or address book writes it (a quoted name may hold a comma), "name, email" or
 * "name<tab>email" (a column copied from a spreadsheet), a name and an address separated by
 * spaces, or an address alone. After the address a line may name its own tracks, separated by
 * ";". A line without an address makes an open link. Empty lines and lines starting with # are
 * skipped. Every problem is reported with its line number and its reason, and nothing is made
 * while any line has one. A line that names no tracks takes the ticked ones; an event with a
 * single track gives it to such a line even when nothing is ticked.
 */
export function parseInviteLines(text: string, tracks: { id: string; name: string }[], defaultTrackIds: string[]): BatchLine[] {
  const byName = new Map(tracks.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const known = new Set(tracks.map((t) => t.id));
  const fallback = defaultTrackIds.length ? defaultTrackIds : tracks.length === 1 ? [tracks[0].id] : [];
  const errors: string[] = [];
  const noTracks: number[] = [];
  const out: BatchLine[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const read = readInviteLine(trimmed);
    if ("error" in read) return void errors.push(`line ${line}: ${read.error}`);
    const { name, email, others } = read;
    if (email && !z.email().safeParse(email).success) return void errors.push(`line ${line}: not an email address: ${email}`);
    if (name.length > 80) return void errors.push(`line ${line}: a name of at most 80 characters`);
    if (others.length > 1) return void errors.push(`line ${line}: more fields than a name, an address and tracks (separate tracks with ";")`);
    let trackIds = fallback;
    const own = (others[0] ?? "").split(";").map((t) => t.trim()).filter(Boolean);
    if (own.length) {
      const unknown = own.filter((t) => !byName.has(t.toLowerCase()));
      if (unknown.length) return void errors.push(`line ${line}: not a track of this event: ${unknown.join(", ")}`);
      trackIds = own.map((t) => byName.get(t.toLowerCase())!);
    }
    trackIds = [...new Set(trackIds)].sort();
    if (!trackIds.length) return void noTracks.push(line);
    if (trackIds.some((id) => !known.has(id))) return void errors.push(`line ${line}: a chosen track is not in this event`);
    if (email) {
      const first = seen.get(email);
      if (first) return void errors.push(`line ${line}: ${email} is on line ${first} already`);
      seen.set(email, line);
    }
    out.push({ line, name, email, trackIds });
  });
  if (noTracks.length) {
    // One plain sentence for every such line: the usual cause is one box nobody ticked, not a fault on each line.
    const which = noTracks.length === 1 ? `line ${noTracks[0]}` : `lines ${listLines(noTracks)}`;
    const example = tracks.length > 1 ? `${tracks[0].name}; ${tracks[1].name}` : (tracks[0]?.name ?? "a track");
    errors.push(`${which}: no tracks. Tick the tracks under "Tracks, for every line that names none", or add them after the address (Name <email>, ${example})`);
  }
  if (errors.length) throw new ValidationError("Check the list: nothing was made.", { lines: errors.slice(0, 12).concat(errors.length > 12 ? [`and ${errors.length - 12} more`] : []) });
  if (!out.length) throw new ValidationError("Check the list: nothing was made.", { lines: ["paste at least one judge, one per line"] });
  if (out.length > MAX_BATCH_INVITES) throw new ValidationError("Check the list: nothing was made.", { lines: [`at most ${MAX_BATCH_INVITES} judges at a time`] });
  return out;
}

/** "1, 2 and 5", or the first ten and a count past them. */
function listLines(lines: number[]): string {
  const shown = lines.slice(0, 10).map(String);
  if (lines.length > 10) return `${shown.join(", ")} and ${lines.length - 10} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
}

const unquote = (s: string) => s.trim().replace(/^["']+|["']+$/g, "").trim();

/** One line's name, address and the fields after them (the line's own tracks), or why it cannot be read. */
function readInviteLine(text: string): { name: string; email: string | null; others: string[] } | { error: string } {
  const brackets = [...text.matchAll(/<([^<>]*)>/g)];
  if (brackets.length > 1) return { error: "two addresses on one line" };
  if (brackets.length === 1) {
    // "Name <email>": the name is everything before the bracket (quotes dropped, so "Chen, Alex" stays whole);
    // what follows it is the line's own tracks. A trailing comma or semicolon from a copied To line is dropped.
    const m = brackets[0];
    const inside = m[1].trim();
    if (!inside.includes("@")) return { error: `the part in <...> is not an email address: ${inside}` };
    const before = unquote(text.slice(0, m.index).replace(/[,;\t]\s*$/, ""));
    const after = text.slice(m.index! + m[0].length).replace(/^[\s,;]+|[\s,;]+$/g, "");
    if (before.includes("@")) return { error: "two addresses on one line" };
    const others = after ? after.split(/[,\t]/).map((f) => f.trim()).filter(Boolean) : [];
    return { name: before, email: inside.toLowerCase(), others };
  }
  if (/[<>]/.test(text)) return { error: "an address in <...> needs both brackets" };
  const fields = text.split(/[,\t]/).map((f) => f.trim()).filter(Boolean);
  const at = fields.filter((f) => f.includes("@"));
  if (at.length > 1) return { error: "two addresses on one line" };
  const rest = fields.filter((f) => !f.includes("@"));
  if (!at.length) return { name: unquote(rest[0] ?? ""), email: null, others: rest.slice(1) };
  // "Mira Ek mira@example.org": a name and an address in one field, separated by spaces.
  const words = at[0].split(/\s+/);
  const addresses = words.filter((w) => w.includes("@"));
  if (addresses.length > 1) return { error: "two addresses on one line" };
  const email = addresses[0].toLowerCase();
  const nameInField = unquote(words.filter((w) => !w.includes("@")).join(" "));
  if (nameInField) return { name: nameInField, email, others: rest };
  return { name: unquote(rest[0] ?? ""), email, others: rest.slice(1) };
}

/**
 * The organizer invites many judges at once from a pasted list: one link each, returned once,
 * one audit row each (judge.invite, as for a single invitation). An address that already
 * judges this event is skipped and reported, never an error; any other problem on any line
 * stops the whole list with the line numbers.
 */
export function inviteJudges(actor: Actor | null, eventIdOrSlug: string, body: unknown): BatchResult {
  let event: EventRow;
  return mutate<BatchResult>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const input = parse(BatchInviteInput, body);
      const eventTracks = tx.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).all();
      const lines = parseInviteLines(input.lines, eventTracks, input.trackIds);
      const emails = lines.flatMap((l) => (l.email ? [l.email] : []));
      const judging = new Set(
        emails.length
          ? tx
              .select({ email: users.email })
              .from(users)
              .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.eventId, event.id), eq(userRoles.role, "judge")))
              .where(inArray(users.email, emails))
              .all()
              .map((u) => u.email.toLowerCase())
          : [],
      );
      const now = new Date().toISOString();
      const invites: BatchInvite[] = [];
      const skipped: BatchResult["skipped"] = [];
      const replaced: ReturnType<typeof replaceOpenInvites> = [];
      const replacedFor: string[] = [];
      for (const l of lines) {
        if (l.email && judging.has(l.email)) {
          skipped.push({ line: l.line, email: l.email, reason: "already a judge in this event" });
          continue;
        }
        const id = newId("jinv");
        const code = newSecret(18);
        const gone = l.email ? replaceOpenInvites(tx, event.id, l.email, now, id) : [];
        if (gone.length) {
          replaced.push(...gone);
          replacedFor.push(l.email!);
        }
        tx.insert(judgeInvites)
          .values({ id, eventId: event.id, codeHash: sha256(code), name: l.name, email: l.email, trackIds: l.trackIds, createdAt: now, createdBy: actor!.userId })
          .run();
        invites.push({ id, code, path: `/judge-invite/${code}`, name: l.name, email: l.email, line: l.line });
      }
      return {
        result: { invites, skipped, replaced: replacedFor },
        // One row per invitation, as a single invite writes; the codes are credentials and never logged.
        audit: [...replaced, ...invites.map((inv) => ({
          action: "judge.invite",
          eventId: event.id,
          targetType: "judge_invite",
          targetId: inv.id,
          after: { name: inv.name, email: inv.email, trackIds: lines.find((l) => l.line === inv.line)!.trackIds, batch: true },
        }))],
      };
    },
  });
}

export function revokeJudgeInvite(actor: Actor | null, inviteId: string) {
  let invite: typeof judgeInvites.$inferSelect;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const row = tx.select().from(judgeInvites).where(eq(judgeInvites.id, inviteId)).get();
      if (!row) throw new NotFoundError("Invitation");
      invite = row;
      return { kind: "event", event: eventFacts(requireEvent(tx, row.eventId)) };
    },
    run: (tx) => {
      if (invite.acceptedAt) throw new ConflictError("invite_used", "This invitation was already accepted. To undo that, remove the judge on the Judges page.");
      if (invite.revokedAt) return { result: { id: invite.id }, audit: null };
      tx.update(judgeInvites).set({ revokedAt: new Date().toISOString() }).where(eq(judgeInvites.id, invite.id)).run();
      return {
        result: { id: invite.id },
        audit: { action: "judge.invite_revoke", eventId: invite.eventId, targetType: "judge_invite", targetId: invite.id },
      };
    },
  });
}

export type JudgeInviteView = {
  event: { id: string; slug: string; name: string };
  name: string;
  email: string | null;
  tracks: string[];
  /** replaced: a newer invitation to the same address replaced this link, which no longer admits anyone */
  state: "open" | "used" | "replaced";
  /** why the event takes no new judges any more (judging closed, results published); null while it does */
  closed: string | null;
};

/**
 * An event takes no new judges once judging is over: a judge who joins after the results
 * are published, or after judging closed, could never score anything and would only add a
 * name to a finished event. A stale invitation link is refused with this, a 409.
 */
export function joiningClosed(event: Pick<EventRow, "resultsPublishedAt" | "judgingCloseAt">, now = new Date()): ConflictError | null {
  if (event.resultsPublishedAt) return new ConflictError("results_published", "The results of this event are published, so it takes no new judges.");
  if (event.judgingCloseAt && now.getTime() >= Date.parse(event.judgingCloseAt)) {
    return new ConflictError("judging_closed", `Judging for this event closed at ${formatUtc(event.judgingCloseAt)}, so it takes no new judges.`);
  }
  return null;
}

/** What the invitation link shows. Public: the code itself is the capability. */
export function judgeInviteByCode(code: string): JudgeInviteView {
  const db = getDb();
  const row = db.select().from(judgeInvites).where(eq(judgeInvites.codeHash, sha256(code))).get();
  if (!row) throw new NotFoundError("Invitation link");
  const replaced = Boolean(row.revokedAt) && wasReplaced(db, row);
  if (row.revokedAt && !replaced) throw new NotFoundError("Invitation link");
  const full = requireEvent(db, row.eventId);
  const names = row.trackIds.length
    ? db.select({ name: tracks.name }).from(tracks).where(inArray(tracks.id, row.trackIds)).orderBy(asc(tracks.position)).all().map((t) => t.name)
    : [];
  return {
    event: { id: full.id, slug: full.slug, name: full.name },
    name: row.name,
    email: row.email,
    tracks: names,
    state: replaced ? "replaced" : row.acceptedAt ? "used" : "open",
    closed: joiningClosed(full)?.message ?? null,
  };
}

export function acceptJudgeInvite(actor: Actor | null, code: string) {
  let invite: typeof judgeInvites.$inferSelect;
  let event: EventRow;
  return mutate({
    actor,
    action: "judge.accept_invite",
    load: (tx) => {
      const row = tx.select().from(judgeInvites).where(eq(judgeInvites.codeHash, sha256(code))).get();
      if (!row) throw new NotFoundError("Invitation link");
      if (row.revokedAt) throw wasReplaced(tx, row) ? inviteReplaced() : new NotFoundError("Invitation link");
      invite = row;
      event = requireEvent(tx, row.eventId);
      return { kind: "judge_invite", event: eventFacts(event), email: row.email };
    },
    run: (tx) => {
      if (invite.acceptedBy === actor!.userId) {
        // Opening one's own used link again is a no-op, unless an organizer has since removed this judge.
        if (isJudgeIn(tx, actor!.userId, event.id)) return { result: { eventSlug: event.slug }, audit: null };
        throw new ConflictError("judge_removed", "An organizer removed you as a judge of this event, so this invitation no longer admits you. Ask them for a new one if that was a mistake.");
      }
      if (invite.acceptedAt) throw new ConflictError("invite_used", "This invitation was already used. Ask the organizer for a new link.");
      const closed = joiningClosed(event);
      if (closed) throw closed;
      const now = new Date().toISOString();
      const known = eventTrackIds(tx, event.id);
      const trackIds = invite.trackIds.filter((id) => known.has(id));
      tx.insert(userRoles).values({ userId: actor!.userId, eventId: event.id, role: "judge", createdAt: now }).onConflictDoNothing().run();
      for (const trackId of trackIds) {
        tx.insert(judgeTracks).values({ judgeUserId: actor!.userId, eventId: event.id, trackId }).onConflictDoNothing().run();
      }
      // The guard in the WHERE, as password resets and claims have it: only an open invitation is taken.
      const took = tx
        .update(judgeInvites)
        .set({ acceptedAt: now, acceptedBy: actor!.userId })
        .where(and(eq(judgeInvites.id, invite.id), isNull(judgeInvites.acceptedAt), isNull(judgeInvites.revokedAt)))
        .run();
      if (took.changes !== 1) throw new ConflictError("invite_used", "This invitation was already used. Ask the organizer for a new link.");
      return {
        result: { eventSlug: event.slug },
        audit: { action: "judge.join", eventId: event.id, targetType: "user", targetId: actor!.userId, after: { invite: invite.id, trackIds } },
      };
    },
  });
}

/**
 * The organizer changes a judge's tracks. Existing assignments stay in the data, but one
 * whose project is in a track the judge no longer has leaves their console and cannot be
 * saved (inJudgeTracks); a top-up run gives that project a judge from its track.
 */
export function setJudgeTracks(actor: Actor | null, eventIdOrSlug: string, judgeUserId: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      if (!isJudgeIn(tx, judgeUserId, event.id)) throw new NotFoundError("Judge");
      const trackIds = checkTracks(tx, event.id, parse(TrackIds, body).trackIds);
      const before = tx
        .select({ id: judgeTracks.trackId })
        .from(judgeTracks)
        .where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id)))
        .all()
        .map((t) => t.id)
        .sort();
      if (before.join() === trackIds.join()) return { result: { trackIds }, audit: null };
      tx.delete(judgeTracks).where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id))).run();
      for (const trackId of trackIds) tx.insert(judgeTracks).values({ judgeUserId, eventId: event.id, trackId }).run();
      return {
        result: { trackIds },
        audit: { action: "judge.tracks", eventId: event.id, targetType: "user", targetId: judgeUserId, before: { trackIds: before }, after: { trackIds } },
      };
    },
  });
}

export const RankingInput = z.object({ show: z.boolean() });

/**
 * Whether each judge's console shows "your ranking so far" (their own finished reviews in
 * the order of their own totals) and how often they used each score. On by default; an
 * organizer who wants judges to score each project against the rubric, not against each
 * other, turns it off. Audited; final once the results are published.
 */
export function setJudgeRanking(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const { show } = parse(RankingInput, body);
      if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so how the event was judged is final.");
      const before = event.settings.judgeRanking !== false;
      if (before === show) return { result: { show, changed: false }, audit: null };
      tx.update(events)
        .set({ settings: { ...event.settings, judgeRanking: show } })
        .where(eq(events.id, event.id))
        .run();
      return {
        result: { show, changed: true },
        audit: { action: "event.judge_ranking", eventId: event.id, targetType: "event", targetId: event.id, before: { show: before }, after: { show } },
      };
    },
  });
}

export type JudgeRow = {
  id: string;
  name: string;
  email: string;
  /** byHand: this track came with an organizer's hand assignment (the project and when), not by an invitation or the tracks form */
  tracks: { id: string; name: string; byHand: { project: string; at: string } | null }[];
  assigned: number;
  done: number;
  pending: number;
  recused: number;
  lastScoredAt: string | null;
  flat: FlatFlag | null;
  override: ActiveOverride | null;
  excluded: boolean;
};

export type InviteRow = {
  id: string;
  name: string;
  email: string | null;
  tracks: string[];
  createdAt: string;
  state: "open" | "used" | "revoked";
  /** a revoked invitation that a newer one to the same address replaced, rather than one an organizer revoked by hand */
  replaced: boolean;
  acceptedBy: string | null;
};

/** Every judge of an event with their tracks, progress and flags. DAL-internal. */
export function judgeRows(db: DbOrTx, eventId: string): JudgeRow[] {
  const people = sortByName(
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .orderBy(asc(users.name))
      .all(),
    (p) => p.name,
  );
  const trackRows = db
    .select({ judgeId: judgeTracks.judgeUserId, id: tracks.id, name: tracks.name })
    .from(judgeTracks)
    .innerJoin(tracks, eq(tracks.id, judgeTracks.trackId))
    .where(eq(judgeTracks.eventId, eventId))
    .orderBy(asc(tracks.position))
    .all();
  // An open review of a project outside the judge's tracks now is not in their console, so it is
  // not open work of theirs: it is counted only while the project is in one of their tracks.
  const counts = db
    .select({
      judgeId: assignments.judgeUserId,
      status: assignments.status,
      n: sql<number>`sum(case when ${assignments.status} != 'pending' or ${inJudgeTracks} then 1 else 0 end)`,
      last: sql<string | null>`max(${scores.submittedAt})`,
    })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .where(eq(assignments.eventId, eventId))
    .groupBy(assignments.judgeUserId, assignments.status)
    .all();
  // Tracks a hand assignment added (assignByHand), marked only while the judge's current grant of the
  // track is that one: the audit log in order, the latest grant per judge and track wins, so a track
  // taken off and given again with the tracks form (or an invitation) is no longer marked by hand.
  const titles = new Map(db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.eventId, eventId)).all().map((x) => [x.id, x.title]));
  const granted = new Map<string, { project: string; at: string } | null>();
  const grants = db
    .select({ action: auditLog.action, targetId: auditLog.targetId, before: auditLog.before, after: auditLog.after, at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), inArray(auditLog.action, ["assignment.by_hand", "judge.tracks", "judge.join"])))
    .orderBy(asc(auditLog.id))
    .all();
  for (const r of grants) {
    const after = (r.after ?? {}) as { judgeUserId?: string; addedTrack?: string | null; trackIds?: string[]; via?: string };
    if (r.action === "assignment.by_hand") {
      if (after.addedTrack && after.judgeUserId) granted.set(`${after.judgeUserId}|${after.addedTrack}`, { project: titles.get(r.targetId ?? "") ?? r.targetId ?? "", at: r.at });
    } else if (after.via !== "assignment.by_hand" && r.targetId) {
      // the tracks form or an invitation: every track it added is granted by that, not by hand
      const had = new Set(((r.before ?? {}) as { trackIds?: string[] }).trackIds ?? []);
      for (const t of after.trackIds ?? []) if (!had.has(t)) granted.set(`${r.targetId}|${t}`, null);
    }
  }
  const set = judgeSet(db, eventId);
  return people.map((p) => {
    const mine = counts.filter((c) => c.judgeId === p.id);
    const of = (s: string) => mine.find((c) => c.status === s)?.n ?? 0;
    const last = mine.map((c) => c.last).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    return {
      ...p,
      tracks: trackRows.filter((t) => t.judgeId === p.id).map(({ id, name }) => ({ id, name, byHand: granted.get(`${p.id}|${id}`) ?? null })),
      assigned: of("pending") + of("done"),
      done: of("done"),
      pending: of("pending"),
      recused: of("recused"),
      lastScoredAt: last,
      flat: set.flags.find((f) => f.judgeId === p.id) ?? null,
      override: [...set.overrides].reverse().find((o) => o.judgeId === p.id) ?? null,
      excluded: set.excluded.includes(p.id),
    };
  });
}

export function inviteRows(db: DbOrTx, eventId: string): InviteRow[] {
  const names = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => [t.id, t.name]));
  // the revocations that name a replacement (replaceOpenInvites), as wasReplaced reads one
  const replaced = new Set(
    db
      .select({ id: auditLog.targetId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "judge.invite_revoke")))
      .all()
      .filter((r) => typeof (r.after as { replacedBy?: unknown } | null)?.replacedBy === "string")
      .map((r) => r.id),
  );
  return db
    .select({
      id: judgeInvites.id,
      name: judgeInvites.name,
      email: judgeInvites.email,
      trackIds: judgeInvites.trackIds,
      createdAt: judgeInvites.createdAt,
      acceptedAt: judgeInvites.acceptedAt,
      revokedAt: judgeInvites.revokedAt,
      acceptedBy: users.name,
    })
    .from(judgeInvites)
    .leftJoin(users, eq(users.id, judgeInvites.acceptedBy))
    .where(eq(judgeInvites.eventId, eventId))
    .orderBy(desc(judgeInvites.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      tracks: r.trackIds.map((id) => names.get(id) ?? id),
      createdAt: r.createdAt,
      state: r.revokedAt ? "revoked" : r.acceptedAt ? "used" : "open",
      replaced: Boolean(r.revokedAt) && replaced.has(r.id),
      acceptedBy: r.acceptedBy,
    }));
}

export type RemovedJudge = { id: string; name: string; email: string; reason: string; at: string };

/** Who was removed as a judge of this event and is not one again, with the reason: the latest removal each. DAL-internal. */
export function removedJudges(db: DbOrTx, eventId: string): RemovedJudge[] {
  const rows = db
    .select({ id: auditLog.targetId, at: auditLog.at, after: auditLog.after, name: users.name, email: users.email })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.targetId))
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "judge.remove")))
    .orderBy(desc(auditLog.id))
    .all();
  const seen = new Set<string>();
  const out: RemovedJudge[] = [];
  for (const r of rows) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    if (isJudgeIn(db, r.id, eventId)) continue;
    const reason = (r.after as { reason?: unknown } | null)?.reason;
    out.push({ id: r.id, name: r.name, email: r.email, reason: typeof reason === "string" ? reason : "", at: r.at });
  }
  return out;
}

export function getJudges(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return {
    event,
    tracks: db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.position)).all(),
    judges: judgeRows(db, event.id),
    invites: inviteRows(db, event.id),
    removed: removedJudges(db, event.id),
  };
}
