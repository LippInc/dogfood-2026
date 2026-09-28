import "server-only";
import { FIELD_LABELS, type ProjectField } from "@/lib/project-fields";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { verifyAuditChain } from "../audit";
import { getDb, type DbOrTx } from "../db/client";
import { formatUtc } from "@/lib/format";
import type { TextEdit } from "@/lib/text-edit";
import { ruleMoves } from "@/lib/vote-rules";
import { assignments, auditLog, events, projects, rubricCriteria, teams, tracks, users, voters } from "../db/schema";
import { guardRead } from "../mutate";
import { toCsv } from "../csv";
import { eventFacts, requireEvent } from "./events";
import { votingState } from "./voting";
import { shownTitle } from "./project-fields";

// The audit log read as sentences ("Jonas Vogel changed Innovation for Paper Anchor
// from 4 to 5"), for the organizer's overview card and the full log page. The
// sentence is built from the row's own before/after, with ids turned into names.
// What a ballot holds stays out of every view of the log until voting closes, the
// same moment the count goes public: organizers see the running count on the Voting
// tab, but the log never shows who picked what while picks can still change. The
// rows are still stored and hashed in full.

export type Part = { text: string; strong?: boolean; mono?: boolean };

export type AuditLine = {
  id: number;
  at: string;
  action: string;
  actor: string;
  parts: Part[];
  targetType: string | null;
  targetId: string | null;
  hash: string;
};

type Row = typeof auditLog.$inferSelect;

type Names = {
  user: Map<string, string>;
  project: Map<string, string>;
  team: Map<string, string>;
  track: Map<string, string>;
  criterion: Map<string, string>;
  assignment: Map<string, { judgeId: string; projectId: string }>;
  voter: Map<string, string>;
  /** True until the event's voting window has closed: ballot contents are not shown. */
  sealed: boolean;
};

const SEALED = "hidden until voting closes";

function loadNames(db: DbOrTx, eventId: string): Names {
  return {
    user: new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name])),
    project: new Map(db.select({ id: projects.id, title: shownTitle() }).from(projects).where(eq(projects.eventId, eventId)).all().map((p) => [p.id, p.title])),
    team: new Map(db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.eventId, eventId)).all().map((t) => [t.id, t.name])),
    track: new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => [t.id, t.name])),
    criterion: new Map(
      db.select({ key: rubricCriteria.key, label: rubricCriteria.label }).from(rubricCriteria).where(eq(rubricCriteria.eventId, eventId)).all().map((c) => [c.key, c.label]),
    ),
    assignment: new Map(
      db
        .select({ id: assignments.id, judgeId: assignments.judgeUserId, projectId: assignments.projectId })
        .from(assignments)
        .where(eq(assignments.eventId, eventId))
        .all()
        .map((a) => [a.id, { judgeId: a.judgeId, projectId: a.projectId }]),
    ),
    voter: new Map(
      db
        .select({ id: voters.id, kind: voters.kind, name: users.name })
        .from(voters)
        .leftJoin(users, eq(users.id, voters.userId))
        .where(eq(voters.eventId, eventId))
        .all()
        .map((v) => [v.id, v.kind === "account" && v.name ? v.name : `${v.kind === "listed" ? "Listed" : "Link"} voter ${v.id.slice(-6)}`]),
    ),
    sealed: ballotsSealed(db, eventId),
  };
}

function ballotsSealed(db: DbOrTx, eventId: string): boolean {
  const e = db.select({ votingOpenAt: events.votingOpenAt, votingCloseAt: events.votingCloseAt }).from(events).where(eq(events.id, eventId)).get();
  return !e || votingState(e) !== "closed";
}

const MODE_WORDS: Record<string, string> = { account: "signed-in accounts", listed: "the voter list", link: "the open link" };
/** What each kind of mail is called in a sentence, one and many. */
const MAIL_WORDS: Record<string, [string, string]> = {
  judge_invite: ["judge invitation", "judge invitations"],
  voter_link: ["voting link", "voting links"],
  claim_link: ["account link", "account links"],
  password_reset: ["password reset link", "password reset links"],
  judge_reminder: ["reminder", "reminders"],
  admin_setup: ["setup link", "setup links"],
};
/** How the open link's ballots were set to count; rows written before the rule existed carry no countLink and say nothing. */
const linkRule = (after: Record<string, unknown>) =>
  typeof after.countLink !== "boolean" || !((after.modes as string[] | undefined) ?? []).includes("link")
    ? ""
    : after.countLink
      ? "; open-link ballots add to the result"
      : "; open-link ballots are counted apart";
const LIMIT_WORDS: Record<string, string> = { ballot: "ballot saves", comment: "comments", "open-link entry": "open-link entries", "sign-in": "sign-in attempts" };
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const quote = (s: unknown) => `“${String(s ?? "")}”`;

/** At most this much of a changed text goes into a sentence; the row itself (the CSV's after column) holds all of it. */
const CLIP = 160;
const clip = (s: string) => {
  const chars = Array.from(s); // whole characters: an emoji is not cut in two
  return quote(chars.length > CLIP ? `${chars.slice(0, CLIP).join("")}…` : s);
};

/** What a review save did to the judge's texts, in words; null when it left both as they were. */
function reviewTexts(after: Record<string, unknown>): { which: string; what: string } | null {
  const edit = (v: unknown): TextEdit | null => (v && typeof v === "object" && "removed" in v && "added" in v ? (v as TextEdit) : null);
  const say = (e: TextEdit) =>
    e.removed && e.added ? `took out ${clip(e.removed)} and wrote ${clip(e.added)}` : e.removed ? `took out ${clip(e.removed)}` : `wrote ${clip(e.added)}`;
  const parts = [
    { which: "their feedback to the team", e: edit(after.feedbackEdit) },
    { which: "their private note", e: edit(after.privateNoteEdit) },
  ].filter((x): x is { which: string; e: TextEdit } => x.e !== null);
  if (!parts.length) return null;
  if (parts.length === 1) return { which: parts[0]!.which, what: say(parts[0]!.e) };
  return { which: "their feedback and their private note", what: parts.map((p) => `${p.which === "their private note" ? "note" : "feedback"}: ${say(p.e)}`).join("; ") };
}

type TrackRow = { id: string; name: string };
const trackRows = (v: unknown): TrackRow[] | null =>
  Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as TrackRow).id === "string") ? (v as TrackRow[]) : null;

/** What a tracks save did, in words, from rows that keep each track's id; null for the rows written before they did (names only). */
function trackChange(before: unknown, after: unknown): string | null {
  const was = trackRows(before);
  const now = trackRows(after);
  if (!was || !now) return null;
  const parts: string[] = [];
  for (const n of now) {
    const o = was.find((x) => x.id === n.id);
    if (!o) parts.push(`added ${quote(n.name)}`);
    else if (o.name !== n.name) parts.push(`renamed ${quote(o.name)} to ${quote(n.name)}`);
  }
  for (const o of was) if (!now.some((n) => n.id === o.id)) parts.push(`removed ${quote(o.name)}`);
  const order = (rows: TrackRow[], other: TrackRow[]) => rows.filter((r) => other.some((x) => x.id === r.id)).map((r) => r.id).join(" ");
  if (order(was, now) !== order(now, was)) parts.push(`put them in the order ${now.map((n) => quote(n.name)).join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

function sentence(r: Row, n: Names): Part[] {
  const label = r.actorUserId ? (n.user.get(r.actorUserId) ?? r.actorLabel) : r.actorLabel;
  const actor: Part = { text: label.charAt(0).toUpperCase() + label.slice(1), strong: true };
  const after = obj(r.after);
  const before = obj(r.before);
  const project = (id: unknown): Part => ({ text: n.project.get(String(id)) ?? String(id), strong: true });
  const person = (id: unknown): Part => ({ text: n.user.get(String(id)) ?? String(id), strong: true });
  const t = (text: string): Part => ({ text });
  const voter = (id: unknown): Part => ({ text: n.voter.get(String(id)) ?? String(id), strong: true });
  const target = r.targetId ?? "";
  switch (r.action) {
    case "fixtures.import": {
      const file = after.source === "upload" ? "an event file" : "the fixture file";
      // rows from before the import listed what it added carry the counts only
      if (!Array.isArray(after.reviews) || !Array.isArray(after.judges)) return [actor, t(` imported ${file}`)];
      const reviews = after.reviews as { finished?: boolean }[];
      const finished = reviews.filter((x) => x.finished).length;
      const judges = after.judges.length;
      return [
        actor,
        t(
          ` imported ${file}: ${judges} ${judges === 1 ? "judge" : "judges"} and ${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}` +
            (reviews.length ? ` (${finished} finished)` : "") +
            ", each listed in this entry",
        ),
      ];
    }
    case "checker_sessions.issued":
      return [actor, t(" issued the four checker sessions")];
    case "checker_sessions.removed":
      return [actor, t(" ended demo mode's access: the checker sessions, the demo sign-ins, and the API tokens, webhooks, account links, password reset links and judge invites made as a demo identity")];
    case "user.sign_up":
      return [actor, t(" created an account")];
    case "session.sign_in":
      return [actor, t(" signed in")];
    case "session.sign_in_demo":
      return [actor, t(" signed in with a demo identity")];
    case "event.create":
      return [actor, t(" created the event")];
    case "event.update":
      return [actor, t(` changed the event's ${Object.keys(after).join(", ") || "details"}`)];
    case "event.tracks": {
      const change = trackChange(r.before, r.after);
      return change ? [actor, t(` changed the tracks: ${change}`)] : [actor, t(" changed the tracks")];
    }
    case "event.prizes":
    case "event.questions":
    case "event.rubric":
      return [actor, t(` changed the ${r.action.split(".")[1]}`)];
    case "event.project_fields": {
      const changed = Object.entries(after).map(([f, m]) => `${FIELD_LABELS[f as ProjectField] ?? f} ${String(m)}`);
      return [actor, t(` changed what teams fill in${changed.length ? `: ${andList(changed)}` : ""}`)];
    }
    case "event.rubric_reweighted":
      return [actor, t(` changed the rubric's weights after judging began: ${quote(after.reason)}`)];
    case "team.create":
      return [actor, t(" created team "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.join":
      return [actor, t(" joined "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.invite_rotated":
      return [actor, t(" replaced the invite link of "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.left":
      return [actor, t(" left "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.member_removed":
      return [actor, t(" took "), person(before.member), t(" off "), { text: n.team.get(target) ?? target, strong: true }];
    case "team.dissolved": {
      const draft = obj(before.draft);
      return [
        actor,
        t(" dissolved team "),
        { text: String(before.name ?? target), strong: true },
        t(draft.id ? `, and its draft “${String(draft.title ?? draft.id)}” with it` : ", which had no project"),
      ];
    }
    case "team.renamed":
      return [actor, t(" renamed team "), { text: String(before.name ?? target), strong: true }, t(" to "), { text: String(after.name ?? ""), strong: true }];
    case "team.renamed_by_organizer":
      return [
        actor,
        t(" renamed team "),
        { text: String(before.name ?? target), strong: true },
        t(" to "),
        { text: String(after.name ?? ""), strong: true },
        t(` as an organizer: ${quote(after.reason)}`),
      ];
    case "team.member_added_by_organizer":
      return [actor, t(" put "), person(after.member), t(" on "), { text: n.team.get(target) ?? target, strong: true }, t(` as an organizer: ${quote(after.reason)}`)];
    case "team.member_removed_by_organizer":
      return [
        actor,
        t(" took "),
        person(before.member),
        t(" off "),
        { text: n.team.get(target) ?? target, strong: true },
        t(` as an organizer: ${quote(after.reason)}`),
        ...(after.captain ? [t("; "), person(after.captain), t(" is captain now")] : []),
      ];
    case "team.captain_changed":
      return [actor, t(" made "), person(after.captain), t(" captain of "), { text: n.team.get(target) ?? target, strong: true }];
    case "project.submit":
      return [actor, t(" submitted "), project(target), { text: ` ${target}`, mono: true }];
    case "project.create":
      return [actor, t(" saved a first draft of "), project(target)];
    case "project.update":
      return [actor, t(" edited "), project(target)];
    case "project.image":
      return [actor, t(after.thumbnailUrl ? " put up a new picture for " : " took down the picture of "), project(target)];
    case "judge.invite":
      return [actor, t(` made a judge invitation for ${after.name || after.email || "an open link"}`)];
    case "judge.invite_revoke":
      return [actor, t(" revoked a judge invitation")];
    case "judge.join":
      return [actor, t(" joined as a judge")];
    case "judge.remove": {
      const out = Array.isArray(after.withdrawn) ? after.withdrawn.length : 0;
      return [
        actor,
        t(" removed "),
        person(target),
        t(" as a judge"),
        t(after.voided ? ", leaving what they saved out of the ranking" : ""),
        t(out ? `, and withdrew ${out} unstarted ${out === 1 ? "review" : "reviews"}` : ""),
        t(`: ${quote(after.reason)}`),
      ];
    }
    case "judge.tracks": {
      const ids = (v: Record<string, unknown>) => (Array.isArray(v.trackIds) ? (v.trackIds as unknown[]).map(String) : []);
      const track = (id: string) => quote(n.track.get(id) ?? id);
      const added = ids(after).filter((id) => !ids(before).includes(id));
      const removed = ids(before).filter((id) => !ids(after).includes(id));
      if (after.via === "assignment.by_hand") {
        return [actor, t(` added ${andList(added.map(track)) || "a track"} to the tracks of `), person(target), t(" with a hand assignment of "), project(after.project), t(`: ${quote(after.reason)}`)];
      }
      const change = [added.length ? `added ${andList(added.map(track))}` : "", removed.length ? `removed ${andList(removed.map(track))}` : ""].filter(Boolean).join("; ");
      return [actor, t(" changed the tracks of "), person(target), ...(change ? [t(`: ${change}`)] : [])];
    }
    case "assignment.run":
      return [
        actor,
        t(` ran ${after.mode === "fresh" ? "the assignment" : "a top-up"}: ${after.added ?? 0} reviews assigned, seed `),
        { text: String(after.seed ?? ""), mono: true },
      ];
    case "project.track_moved": {
      const gone = Array.isArray(after.withdrawn) ? after.withdrawn.length : 0;
      return [
        actor,
        t(" moved "),
        project(target),
        t(` from ${n.track.get(String(before.trackId)) ?? before.trackId} to ${n.track.get(String(after.trackId)) ?? after.trackId}`),
        t(gone ? `, withdrawing ${gone} unstarted ${gone === 1 ? "review" : "reviews"}` : ""),
        t(`: ${quote(after.reason)}`),
      ];
    }
    case "assignment.remove":
      return [actor, t(" took "), project(target), t(" back from "), person(after.judgeUserId), t(`: ${quote(after.reason)}`)];
    case "assignment.recusal_undone":
      return [actor, t(" gave "), project(after.project), t(" back to "), person(after.judgeUserId), t(`, undoing their recusal: ${quote(after.reason)}`)];
    case "assignment.by_hand":
      return [
        actor,
        t(" gave "),
        project(target),
        t(" to "),
        person(after.judgeUserId),
        t(after.addedTrack ? ` by hand, which added the track ${quote(n.track.get(String(after.addedTrack)) ?? after.addedTrack)} to theirs: ${quote(after.reason)}` : ` by hand: ${quote(after.reason)}`),
      ];
    case "review.save":
    case "review.submit":
    case "review.amend": {
      const a = n.assignment.get(target);
      const proj = project(after.project ?? a?.projectId ?? "");
      const keys = Object.keys(after).filter((k) => n.criterion.has(k));
      // a save that changed only the feedback or the private note says what it took out and wrote
      const texts = reviewTexts(after);
      if (keys.length === 0 && texts && r.action !== "review.submit") return [actor, t(` edited ${texts.which} on `), proj, t(`: ${texts.what}`)];
      if (r.action === "review.amend" && keys.length === 1) {
        const k = keys[0]!;
        return [actor, t(` changed ${n.criterion.get(k)} for `), proj, t(` from ${before[k] ?? "–"} to ${after[k] ?? "–"}`)];
      }
      if (r.action === "review.submit") return [actor, t(" finished scoring "), proj, t(typeof after.total === "number" ? `: ${after.total.toFixed(2)}` : "")];
      if (r.action === "review.amend") return [actor, t(" changed the score for "), proj];
      return [actor, t(" saved a draft score for "), proj];
    }
    case "review.recuse": {
      const a = n.assignment.get(target);
      return [actor, t(" declared a conflict of interest on "), project(after.project ?? a?.projectId), t(`: ${quote(after.reason)}`)];
    }
    case "judge.override":
      return [actor, t(after.mode === "include" ? " reinstated " : " left out "), person(target), t(`: ${quote(after.reason)}`)];
    case "pairwise.pick": {
      const said = after.outcome === "tie" ? "called " : "compared ";
      const pick = after.outcome === "left" ? after.left : after.outcome === "right" ? after.right : null;
      return pick
        ? [actor, t(" picked "), project(String(pick)), t(" over "), project(String(pick === after.left ? after.right : after.left))]
        : [actor, t(` ${said}`), project(String(after.left)), t(" and "), project(String(after.right)), t(" too close to call")];
    }
    case "pairwise.undo":
      return [actor, t(" took back an answer about "), project(String(before.left)), t(" and "), project(String(before.right))];
    case "event.judging_mode":
      return [actor, t(after.mode === "pairwise" ? " switched judging to pairwise: " : " switched judging to rubric scores: "), t(quote(after.reason))];
    case "event.judge_ranking":
      return [actor, t(after.show ? " let judges see their own ranking so far" : " hid each judge's own ranking so far from their console")];
    case "judge.override_revoke":
      return [actor, t(" undid the override on "), person(target)];
    case "event.organizer_added":
      return [actor, t(" made "), person(target), t(" an organizer")];
    case "event.organizer_removed":
      return [actor, t(" removed "), person(target), t(" as an organizer")];
    case "project.merge":
      return [actor, t(" merged "), project(target), { text: ` ${target}`, mono: true }, t(" into "), { text: String(after.into), mono: true }];
    case "project.unmerge":
      return [actor, t(" undid the merge of "), project(target)];
    case "project.not_duplicate":
      return [actor, t(` ruled ${(after.ids as string[] | undefined)?.join(" and ") ?? target} are different projects: ${quote(after.reason)}`)];
    case "project.not_duplicate_undo":
      return [actor, t(` undid the ruling that ${(before.ids as string[] | undefined)?.join(" and ") ?? target} are different projects`)];
    case "project.accept_under_reviewed":
      return [actor, t(" will publish "), project(target), t(` with fewer than two reviews: ${quote(after.reason)}`)];
    case "project.accept_under_reviewed_undo":
      return [actor, t(" undid publishing "), project(target), t(" as it is")];
    case "results.publish":
      return [
        actor,
        t(
          after.voteEnded === "open"
            ? " published the results and closed the community vote"
            : after.voteEnded === "upcoming"
              ? " published the results and called off the community vote that had not opened"
              : " published the results",
        ),
      ];
    case "authz.refused":
      return [actor, t(` was refused: ${after.attempted ?? "an action"} (${after.code ?? after.status})`)];
    case "voting.settings":
      return after.votingOpenAt && after.votingCloseAt
        ? [
            actor,
            t(
              ` set community voting from ${formatUtc(String(after.votingOpenAt))} to ${formatUtc(String(after.votingCloseAt))}, ` +
                `${after.votesPerVoter} votes each, for ${andList(((after.modes as string[] | undefined) ?? []).map((m) => MODE_WORDS[m] ?? m))}${linkRule(after)}`,
            ),
          ]
        : [actor, t(" cleared the community voting window")];
    case "voting.rules_changed":
      return [
        actor,
        t(` changed the community vote's rules after ballots were in: ${ruleMoves({ before: { modes: (before.modes as string[] | undefined) ?? [], votesPerVoter: Number(before.votesPerVoter) }, after: { modes: (after.modes as string[] | undefined) ?? [], votesPerVoter: Number(after.votesPerVoter) } }) || "the same rules"}: ${quote(after.reason)}`),
      ];
    case "voting.demo_opened":
      return after.votingCloseAt
        ? [
            actor,
            t(
              ` opened the demo community vote until ${formatUtc(String(after.votingCloseAt))}, ${after.votesPerVoter} votes each, ` +
                `for ${andList(((after.modes as string[] | undefined) ?? []).map((m) => MODE_WORDS[m] ?? m))}${linkRule(after)}`,
            ),
          ]
        : [actor, t(" opened the demo community vote")];
    case "voting.link":
      return [actor, t(after.replaced ? " made a new open voting link; the old one stopped working" : " made the open voting link")];
    case "voting.voters_added": {
      const added = Number(after.added ?? 0);
      const skipped = Number(after.skipped ?? 0);
      return [actor, t(` added ${added} ${added === 1 ? "person" : "people"} to the voter list${skipped ? ` (${skipped} already on it)` : ""}`)];
    }
    case "mail.sent": {
      const sent = Number(after.sent ?? 0);
      const failed = Number(after.failed ?? 0);
      const [one, many] = MAIL_WORDS[String(after.kind)] ?? ["message", "messages"];
      const count = (k: number) => `${k} ${k === 1 ? one : many}`;
      return [actor, t(sent ? ` mailed ${count(sent)}${failed ? `; ${failed} could not be sent` : ""}` : ` could not mail ${count(failed)}`)];
    }
    case "voter.join_link":
      return [actor, t(" entered voting with the open link")];
    case "vote.cast": {
      if (n.sealed) return [actor, t(` changed their ballot (${SEALED})`)];
      const picks = ((after.picks as string[] | undefined) ?? []).map(project);
      if (!picks.length) return [actor, t(" cleared their ballot")];
      return [actor, t(" voted for "), ...picks.flatMap((p, i) => (i === 0 ? [p] : [t(i === picks.length - 1 ? " and " : ", "), p]))];
    }
    case "voter.void":
      return [actor, t(" set aside the ballot of "), voter(target), t(`: ${quote(after.reason)}`)];
    case "voter.restore":
      return [actor, t(" counted the ballot of "), voter(target), t(" again")];
    case "voter.new_link":
      return [actor, t(" made a new voting link for "), voter(target), t("; the old one stopped working")];
    case "comment.post":
      return [actor, t(" commented on "), project(target)];
    case "project.image_taken_down":
      return [actor, t(" took down the picture of "), project(target), t(`: ${quote(after.reason)}`)];
    case "comment.deleted":
      return [actor, t(" deleted their comment on "), project(target)];
    case "comment.unhide":
      return [actor, t(" showed a hidden comment on "), project(target), t(` again (it was hidden: ${quote(before.reason)})`)];
    case "comment.hide":
      return [actor, t(" hid a comment on "), project(target), t(`: ${quote(after.reason)}`)];
    case "record.issue": {
      const what = after.kind === "judge" ? "judging record" : "certificate";
      return after.subject === r.actorUserId
        ? [actor, t(` got their signed ${what}`)]
        : [actor, t(` issued the signed ${what} of `), person(after.subject)];
    }
    case "records.issue_all":
      return [actor, t(` issued ${after.judges} judging records and ${after.participants} certificates`)];
    case "webhook.create":
      return [actor, t(` added a webhook to ${after.url} for ${(after.actions as string[] | undefined)?.includes("*") ? "every action" : andList((after.actions as string[] | undefined) ?? [])}`)];
    case "webhook.disable":
      return [actor, t(" turned off webhook "), { text: target, mono: true }];
    case "webhook.enable":
      return [actor, t(" turned on webhook "), { text: target, mono: true }];
    case "webhook.rotate_secret":
      return [actor, t(" gave webhook "), { text: target, mono: true }, t(" a new secret")];
    case "webhook.test":
      return [actor, t(" sent a test to webhook "), { text: target, mono: true }];
    case "webhook.redeliver":
      return [actor, t(" asked webhook "), { text: target, mono: true }, t(` to send ${after.delivery} again`)];
    case "signing_key.create":
      return after.replaces
        ? [actor, t(" made the signing key "), { text: target, mono: true }, t(", since "), { text: String(after.replaces), mono: true }, t(" is sealed under another secret")]
        : [actor, t(" made the signing key "), { text: target, mono: true }];
    case "signing_key.seal":
      return [actor, t(" sealed the signing key "), { text: target, mono: true }, t(" under the portal's secret")];
    case "token.create":
      return [actor, t(" made the API token "), { text: String(after.name ?? target), mono: true }];
    case "token.revoke":
      return [actor, t(" revoked the API token "), { text: String(after.name ?? target), mono: true }];
    case "claims.issue": {
      const links = Number(after.links ?? 0);
      const elsewhere = Number(after.elsewhere ?? 0);
      const left = elsewhere ? `; ${elsewhere} left for the administrator, who also belong to an event this organizer does not run` : "";
      return [actor, t(` made ${links} set-a-password ${links === 1 ? "link" : "links"} for people who came in through an import${left}`)];
    }
    case "user.claim":
      return [actor, t(" set a password with their link")];
    case "user.reset_link":
      return [actor, t(" made a one-time link for "), person(target), t(" to set a new password")];
    case "user.password_reset": {
      const ended = Number(after.sessionsEnded ?? 0);
      return [actor, t(` set a new password with a one-time link, which signed out ${ended} ${ended === 1 ? "session" : "sessions"}`)];
    }
    case "ratelimit.refused":
      return [actor, t(` was asked to slow down (too many ${LIMIT_WORDS[target] ?? target}; wait ${after.retryAfter} s)`)];
    default:
      return [actor, t(` ${r.action}`)];
  }
}

function lines(db: DbOrTx, eventId: string, rows: Row[]): AuditLine[] {
  const names = loadNames(db, eventId);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    action: r.action,
    actor: r.actorLabel,
    parts: sentence(r, names),
    targetType: r.targetType,
    targetId: r.targetId,
    hash: r.hash,
  }));
}

/** The latest entries of one event's log, newest first. DAL-internal (the overview card). */
export function latestAudit(db: DbOrTx, eventId: string, limit = 4, actions?: string[]): AuditLine[] {
  const where = actions ? and(eq(auditLog.eventId, eventId), inArray(auditLog.action, actions)) : eq(auditLog.eventId, eventId);
  return lines(db, eventId, db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(limit).all());
}

/** Everything the log holds about one row (a team, a project), newest first. DAL-internal: callers check the reader first. */
export function auditOfTarget(db: DbOrTx, eventId: string, targetType: string, targetId: string, limit = 50): AuditLine[] {
  const rows = db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.targetType, targetType), eq(auditLog.targetId, targetId), sql`${auditLog.action} <> 'authz.refused'`))
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .all();
  return lines(db, eventId, rows);
}

export function getAuditLog(actor: Actor | null, eventIdOrSlug: string, opts: { limit?: number } = {}) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const rows = db
    .select()
    .from(auditLog)
    .where(eq(auditLog.eventId, event.id))
    .orderBy(desc(auditLog.id))
    .limit(opts.limit ?? 500)
    .all();
  const total = db.select({ n: sql<number>`count(*)` }).from(auditLog).where(eq(auditLog.eventId, event.id)).get()!.n;
  return { event, lines: lines(db, event.id, rows), total, chain: verifyAuditChain(db) };
}

/** One entry as the API gives it: the sentence the log page shows, as plain text, and the row's own fields. */
export type AuditEntryView = Omit<AuditLine, "parts"> & { sentence: string };
const plain = (l: AuditLine): AuditEntryView => ({
  id: l.id,
  at: l.at,
  action: l.action,
  actor: l.actor,
  sentence: l.parts.map((p) => p.text).join(""),
  targetType: l.targetType,
  targetId: l.targetId,
  hash: l.hash,
});

/** The event's log for the API: what its log page shows (a ballot's picks sealed until voting closes). Organizers. */
export function getAuditEntries(actor: Actor | null, eventIdOrSlug: string, opts: { limit?: number } = {}) {
  const { lines: rows, total, chain } = getAuditLog(actor, eventIdOrSlug, opts);
  return { total, chain, entries: rows.map(plain) };
}

/**
 * The portal's own log: the rows no event owns (accounts made, sign-ins, API tokens, the
 * signing key, demo mode, refusals outside any event), newest first. Administrators only.
 */
export function getPortalLog(actor: Actor | null, opts: { limit?: number } = {}) {
  const db = getDb();
  guardRead(actor, "portal.audit", { kind: "platform" });
  const rows = db
    .select()
    .from(auditLog)
    .where(isNull(auditLog.eventId))
    .orderBy(desc(auditLog.id))
    .limit(opts.limit ?? 500)
    .all();
  const total = db.select({ n: sql<number>`count(*)` }).from(auditLog).where(isNull(auditLog.eventId)).get()!.n;
  return { lines: lines(db, "", rows), total, chain: verifyAuditChain(db) };
}

/** The portal's log for the API. Administrators only. */
export function getPortalEntries(actor: Actor | null, opts: { limit?: number } = {}) {
  const { lines: rows, total, chain } = getPortalLog(actor, opts);
  return { total, chain, entries: rows.map(plain) };
}

/** The event's log as CSV, oldest first, every row with its own hash and the one before. */
export function auditCsv(db: DbOrTx, eventId: string): string {
  const rows = db.select().from(auditLog).where(eq(auditLog.eventId, eventId)).orderBy(auditLog.id).all();
  const text = lines(db, eventId, rows);
  const head = verifyAuditChain(db);
  const sealed = ballotsSealed(db, eventId);
  const payload = (r: Row, v: unknown) => (v === null ? "" : sealed && r.action === "vote.cast" ? SEALED : JSON.stringify(v));
  return toCsv(
    ["id", "at", "actor", "action", "sentence", "target_type", "target_id", "before", "after", "prev_hash", "hash", "chain_ok", "chain_head"],
    rows.map((r, i) => [
      r.id,
      r.at,
      r.actorLabel,
      r.action,
      text[i]!.parts.map((p) => p.text).join(""),
      r.targetType ?? "",
      r.targetId ?? "",
      payload(r, r.before),
      payload(r, r.after),
      r.prevHash,
      r.hash,
      head.ok ? "yes" : "no",
      head.ok ? (head.head ?? "") : `broken at ${head.brokenAtId}`,
    ]),
  );
}
