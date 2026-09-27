import "server-only";
import type { Role } from "./db/schema";
import { formatUtc } from "@/lib/format";

// authorize(actor, action, resource) is the one place a permission is decided.
// It is pure: callers load the facts (roles, event dates, team membership) inside
// the transaction that will act on the answer, and pass them in. Convention: no or
// invalid session is 401, a valid session without permission is 403. A refusal is
// always a real 4xx from the route that was asked, never a redirect.

export type Actor = {
  userId: string;
  name: string;
  email: string;
  isAdmin: boolean;
  roles: { eventId: string; role: Role }[];
  sessionKind: "login" | "checker" | "api";
};

/** The facts about an event that permissions depend on. */
export type EventFacts = {
  id: string;
  submissionsOpenAt: string | null;
  submissionsCloseAt: string;
  resultsPublishedAt: string | null;
  /** null: judging stays open until results are published */
  judgingCloseAt?: string | null;
  votingOpenAt?: string | null;
  votingCloseAt?: string | null;
};

export type VoterKind = "account" | "listed" | "link";

export type Action =
  | "event.create"
  | "portal.audit"
  | "portal.accounts"
  | "event.manage"
  | "event.export"
  | "organizer.add"
  | "team.create"
  | "team.join"
  | "team.manage"
  | "team.leave"
  | "team.members"
  | "project.create"
  | "project.edit"
  | "scores.read_own"
  | "scores.read_judge"
  | "judge.accept_invite"
  | "judging.console"
  | "review.save"
  | "review.recuse"
  | "pairwise.pick"
  | "vote.cast"
  | "comment.post"
  | "record.issue_own"
  | "records.issue_all"
  | "account.tokens";

export type Resource =
  | { kind: "platform" }
  | { kind: "event"; event: EventFacts }
  /**
   * onTeam: the actor is a member of a team in this event (create, join) or of this project's team (edit);
   * assignedToTeam (join): the actor is assigned to judge this team's project
   */
  | { kind: "team_work"; event: EventFacts; onTeam: boolean; assignedToTeam?: boolean }
  /** one team, from the actor's point of view */
  | { kind: "team"; event: EventFacts; isMember: boolean; isCaptain: boolean }
  /** judgeUserId: whose scores are asked for; the peer route passes the requested id */
  | { kind: "judge_scores"; judgeUserId: string }
  /** email: the address the invitation was made for, or null for an open link */
  | { kind: "judge_invite"; event: EventFacts; email: string | null }
  /** one judge's assignment of one project; inJudgeTracks: the project is in one of that judge's tracks now */
  | { kind: "assignment"; id: string; event: EventFacts; judgeUserId: string; status: "pending" | "done" | "recused"; inJudgeTracks: boolean }
  /** an account being made an organizer of this event; otherEventIds: the other events where it has a role or a team seat */
  | { kind: "organizer_candidate"; event: EventFacts; otherEventIds: string[] }
  /** a community ballot; voter: who the voting link or account proves, or null */
  | { kind: "ballot"; event: EventFacts; modes: VoterKind[]; voter: { id: string; kind: VoterKind; voided: boolean } | null }
  /** comments on one project */
  | { kind: "project_comments"; event: EventFacts; projectId: string; submitted: boolean }
  /** the actor's own signed record: finishedReviews, answers (pairwise) and onSubmittedTeam are the actor's, in this event */
  | { kind: "record_subject"; event: EventFacts; recordKind: "judge" | "participant"; finishedReviews: number; answers: number; onSubmittedTeam: boolean };

export type Refusal = { ok: false; status: 401 | 403; code: string; message: string };
export type Decision = { ok: true } | Refusal;

const allow: Decision = { ok: true };
const unauthenticated: Refusal = {
  ok: false,
  status: 401,
  code: "unauthenticated",
  message: "Sign in first: this request carried no valid session.",
};
const refuse = (code: string, message: string): Refusal => ({ ok: false, status: 403, code, message });

export function hasRole(actor: Actor, eventId: string, role: Role): boolean {
  return actor.roles.some((r) => r.eventId === eventId && r.role === role);
}

export function isJudgeAnywhere(actor: Actor): boolean {
  return actor.roles.some((r) => r.role === "judge");
}

/** Submissions are open from submissions_open_at (or creation) until submissions_close_at, exclusive. */
export function submissionsOpen(event: EventFacts, now: Date): boolean {
  const close = Date.parse(event.submissionsCloseAt);
  const open = event.submissionsOpenAt ? Date.parse(event.submissionsOpenAt) : -Infinity;
  const t = now.getTime();
  return t >= open && t < close;
}

/** Judging opens when submissions close and ends at judging_close_at or when results are published. */
function judgingRefusal(event: EventFacts, now: Date, what = "scores"): Refusal | null {
  const t = now.getTime();
  if (t < Date.parse(event.submissionsCloseAt)) {
    return refuse("judging_not_open", `Judging opens when submissions close, at ${formatUtc(event.submissionsCloseAt)}.`);
  }
  if (event.resultsPublishedAt) return refuse("results_published", `Results are published, so ${what} are final.`);
  if (event.judgingCloseAt && t >= Date.parse(event.judgingCloseAt)) {
    return refuse("judging_closed", `Judging closed at ${formatUtc(event.judgingCloseAt)}.`);
  }
  return null;
}

function windowRefusal(event: EventFacts, now: Date, what: string): Refusal {
  return now.getTime() >= Date.parse(event.submissionsCloseAt)
    ? refuse("submissions_closed", `Submissions closed at ${formatUtc(event.submissionsCloseAt)}. ${what}.`)
    : refuse("submissions_not_open", `Submissions open at ${formatUtc(event.submissionsOpenAt)}.`);
}

/**
 * A ballot is proved by the voter's link token or by their account, so a voter may
 * have no session at all: 401 means neither proof came with the request.
 */
function decideVote(resource: Resource, now: Date): Decision {
  if (resource.kind !== "ballot") return refuse("bad_resource", "This action needs a ballot.");
  const { event, voter } = resource;
  if (!voter) {
    return { ...unauthenticated, message: "Open your voting link, or sign in if this event lets accounts vote." };
  }
  if (!resource.modes.includes(voter.kind)) return refuse("voting_mode_off", "This event does not take votes this way.");
  if (voter.voided) return refuse("voter_voided", "The organizers set this ballot aside as a suspected duplicate.");
  if (!event.votingOpenAt || !event.votingCloseAt) return refuse("voting_not_set", "This event has no voting window.");
  const t = now.getTime();
  if (t < Date.parse(event.votingOpenAt)) return refuse("voting_not_open", `Voting opens at ${formatUtc(event.votingOpenAt)}.`);
  if (t >= Date.parse(event.votingCloseAt)) return refuse("voting_closed", `Voting closed at ${formatUtc(event.votingCloseAt)}.`);
  return allow;
}

export function authorize(
  actor: Actor | null,
  action: Action,
  resource: Resource,
  now: Date = new Date(),
): Decision {
  if (action === "vote.cast") return decideVote(resource, now);
  if (!actor) return unauthenticated;

  switch (action) {
    case "event.create":
      return actor.isAdmin ? allow : refuse("not_an_admin", "Only an administrator of this portal can create events.");

    case "portal.audit":
      return actor.isAdmin ? allow : refuse("not_an_admin", "Only an administrator of this portal can read the portal's own log.");

    case "portal.accounts":
      return actor.isAdmin ? allow : refuse("not_an_admin", "Only an administrator of this portal can make a password reset link.");

    case "event.manage":
    case "event.export": {
      if (resource.kind !== "event") return refuse("bad_resource", "This action needs an event.");
      return hasRole(actor, resource.event.id, "organizer")
        ? allow
        : refuse("not_an_organizer", "Only this event's organizers can do this.");
    }

    case "organizer.add": {
      // Nobody is asked before becoming an organizer, so an organizer reaches only accounts
      // with no place in an event they do not run: otherwise one event's organizer could pull
      // another event's people in (and their first password with them). An administrator,
      // who can send anyone a reset link anyway, reaches everyone.
      if (resource.kind !== "organizer_candidate") return refuse("bad_resource", "This action needs an event and an account.");
      if (!hasRole(actor, resource.event.id, "organizer")) return refuse("not_an_organizer", "Only this event's organizers can do this.");
      if (!actor.isAdmin && resource.otherEventIds.some((id) => !hasRole(actor, id, "organizer"))) {
        return refuse("account_in_other_event", "That account also belongs to an event you do not run, so only the portal's administrator can make it an organizer here.");
      }
      return allow;
    }

    case "team.create":
    case "team.join": {
      if (resource.kind !== "team_work") return refuse("bad_resource", "This action needs an event.");
      if (resource.onTeam) {
        return refuse("already_on_a_team", "You are already on a team in this event; one person, one team.");
      }
      // Assignment keeps judges off their own team's project; joining later must not undo that.
      if (resource.assignedToTeam) {
        return refuse(
          "conflict_of_interest",
          "You are assigned to judge this team's project. Declare the conflict in your judging console first, then join.",
        );
      }
      if (!submissionsOpen(resource.event, now)) return windowRefusal(resource.event, now, "Teams can no longer be formed");
      return allow;
    }

    case "team.manage": {
      if (resource.kind !== "team") return refuse("bad_resource", "This action needs a team.");
      return resource.isCaptain ? allow : refuse("not_the_captain", "Only the team's captain can do this.");
    }

    // Who is on a team changes only while submissions are open: the team that submitted is the team judged.
    case "team.leave": {
      if (resource.kind !== "team") return refuse("bad_resource", "This action needs a team.");
      if (!resource.isMember) return refuse("not_on_this_team", "You are not on this team.");
      if (!submissionsOpen(resource.event, now)) return windowRefusal(resource.event, now, "Teams can no longer change");
      return allow;
    }

    case "team.members": {
      if (resource.kind !== "team") return refuse("bad_resource", "This action needs a team.");
      if (!resource.isCaptain) return refuse("not_the_captain", "Only the team's captain can do this.");
      if (!submissionsOpen(resource.event, now)) return windowRefusal(resource.event, now, "Teams can no longer change");
      return allow;
    }

    case "project.create":
    case "project.edit": {
      if (resource.kind !== "team_work") return refuse("bad_resource", "This action needs a team and an event.");
      if (!resource.onTeam) {
        return action === "project.create"
          ? refuse("not_on_a_team", "Join or create a team in this event before submitting a project.")
          : refuse("not_your_project", "Only members of this project's team can edit it.");
      }
      if (!submissionsOpen(resource.event, now)) {
        return windowRefusal(resource.event, now, "The project can no longer be submitted or edited");
      }
      return allow;
    }

    case "scores.read_own":
      return isJudgeAnywhere(actor) ? allow : refuse("not_a_judge", "Only judges have scores to read.");

    case "scores.read_judge": {
      if (resource.kind !== "judge_scores") return refuse("bad_resource", "This action needs a judge id.");
      if (!isJudgeAnywhere(actor)) return refuse("not_a_judge", "Only judges have scores to read.");
      // Never fall back to the caller's own rows: asking for someone else's is a refusal.
      return resource.judgeUserId === actor.userId
        ? allow
        : refuse("not_your_scores", "A judge can read only their own scores.");
    }

    case "judge.accept_invite": {
      if (resource.kind !== "judge_invite") return refuse("bad_resource", "This action needs an invitation.");
      if (resource.email && resource.email !== actor.email.toLowerCase()) {
        return refuse(
          "invite_for_someone_else",
          "This invitation was made for another email address. Sign in with that address, or ask the organizer for a new link.",
        );
      }
      return allow;
    }

    case "judging.console": {
      if (resource.kind !== "event") return refuse("bad_resource", "This action needs an event.");
      return hasRole(actor, resource.event.id, "judge")
        ? allow
        : refuse("not_a_judge_here", "Only this event's judges can open its judging console.");
    }

    case "pairwise.pick": {
      // Pairwise mode: the judge's own answer about two of their own projects. The judge
      // id is the session's; which two projects is the server's question, checked in the DAL.
      if (resource.kind !== "event") return refuse("bad_resource", "This action needs an event.");
      if (!hasRole(actor, resource.event.id, "judge")) {
        return refuse("not_a_judge_here", "Only this event's judges can compare its projects.");
      }
      return judgingRefusal(resource.event, now, "answers") ?? allow;
    }

    case "review.save":
    case "review.recuse": {
      if (resource.kind !== "assignment") return refuse("bad_resource", "This action needs an assignment.");
      // The judge id comes from the assignment row, the actor from the session.
      if (resource.judgeUserId !== actor.userId) {
        return refuse("not_your_assignment", "A judge can score only the projects assigned to them.");
      }
      if (!hasRole(actor, resource.event.id, "judge")) {
        return refuse("not_a_judge_here", "You are no longer a judge in this event.");
      }
      // A track judge never sees another track, whatever the assignment row says.
      if (!resource.inJudgeTracks) {
        return refuse("outside_your_tracks", "This project is not in one of your tracks any more, so it is not yours to see or score.");
      }
      if (resource.status === "recused") {
        return refuse("recused", "You declared a conflict on this project, so it is no longer yours to score.");
      }
      return judgingRefusal(resource.event, now) ?? allow;
    }

    case "comment.post": {
      if (resource.kind !== "project_comments") return refuse("bad_resource", "This action needs a project.");
      return resource.submitted ? allow : refuse("not_submitted", "Comments open once a project is submitted.");
    }

    case "record.issue_own": {
      if (resource.kind !== "record_subject") return refuse("bad_resource", "This action needs an event and a kind of record.");
      if (resource.recordKind === "judge") {
        if (!hasRole(actor, resource.event.id, "judge")) return refuse("not_a_judge_here", "Only this event's judges get a judging record.");
        if (resource.finishedReviews < 1 && resource.answers < 1) {
          return refuse("no_finished_reviews", "A judging record needs at least one finished review or pairwise answer.");
        }
      } else if (!resource.onSubmittedTeam) {
        return refuse("not_on_a_submitted_team", "Certificates go to members of teams that submitted a project.");
      }
      return resource.event.resultsPublishedAt ? allow : refuse("results_not_published", "Records and certificates are issued once the results are published.");
    }

    case "account.tokens":
      // a leaked token must not be able to mint more tokens or hide itself
      return actor.sessionKind === "api" ? refuse("token_cannot_manage_tokens", "Sign in to make or revoke API tokens; a token cannot.") : allow;

    case "records.issue_all": {
      if (resource.kind !== "event") return refuse("bad_resource", "This action needs an event.");
      if (!hasRole(actor, resource.event.id, "organizer")) return refuse("not_an_organizer", "Only this event's organizers can do this.");
      return resource.event.resultsPublishedAt ? allow : refuse("results_not_published", "Records and certificates are issued once the results are published.");
    }

  }
}
