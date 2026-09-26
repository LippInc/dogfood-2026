import "server-only";
import type { Role } from "./db/schema";

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
  sessionKind: "login" | "checker";
};

/** The facts about an event that permissions depend on. */
export type EventFacts = {
  id: string;
  submissionsOpenAt: string | null;
  submissionsCloseAt: string;
  resultsPublishedAt: string | null;
  /** null: judging stays open until results are published */
  judgingCloseAt?: string | null;
};

export type Action =
  | "event.create"
  | "event.manage"
  | "event.export"
  | "team.create"
  | "team.join"
  | "team.manage"
  | "project.create"
  | "project.edit"
  | "scores.read_own"
  | "scores.read_judge"
  | "judge.accept_invite"
  | "judging.console"
  | "review.save"
  | "review.recuse";

export type Resource =
  | { kind: "platform" }
  | { kind: "event"; event: EventFacts }
  /** onTeam: the actor is a member of a team in this event (create, join) or of this project's team (edit) */
  | { kind: "team_work"; event: EventFacts; onTeam: boolean }
  /** one team, from the actor's point of view */
  | { kind: "team"; event: EventFacts; isMember: boolean; isCaptain: boolean }
  /** judgeUserId: whose scores are asked for; the peer route passes the requested id */
  | { kind: "judge_scores"; judgeUserId: string }
  /** email: the address the invitation was made for, or null for an open link */
  | { kind: "judge_invite"; event: EventFacts; email: string | null }
  /** one judge's assignment of one project */
  | { kind: "assignment"; id: string; event: EventFacts; judgeUserId: string; status: "pending" | "done" | "recused" };

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
function judgingRefusal(event: EventFacts, now: Date): Refusal | null {
  const t = now.getTime();
  if (t < Date.parse(event.submissionsCloseAt)) {
    return refuse("judging_not_open", `Judging opens when submissions close, at ${event.submissionsCloseAt}.`);
  }
  if (event.resultsPublishedAt) return refuse("results_published", "Results are published, so scores are final.");
  if (event.judgingCloseAt && t >= Date.parse(event.judgingCloseAt)) {
    return refuse("judging_closed", `Judging closed at ${event.judgingCloseAt}.`);
  }
  return null;
}

function windowRefusal(event: EventFacts, now: Date, what: string): Refusal {
  return now.getTime() >= Date.parse(event.submissionsCloseAt)
    ? refuse("submissions_closed", `Submissions closed at ${event.submissionsCloseAt}. ${what}.`)
    : refuse("submissions_not_open", `Submissions open at ${event.submissionsOpenAt}.`);
}

export function authorize(
  actor: Actor | null,
  action: Action,
  resource: Resource,
  now: Date = new Date(),
): Decision {
  if (!actor) return unauthenticated;

  switch (action) {
    case "event.create":
      return actor.isAdmin ? allow : refuse("not_an_admin", "Only an administrator of this portal can create events.");

    case "event.manage":
    case "event.export": {
      if (resource.kind !== "event") return refuse("bad_resource", "This action needs an event.");
      return hasRole(actor, resource.event.id, "organizer")
        ? allow
        : refuse("not_an_organizer", "Only this event's organizers can do this.");
    }

    case "team.create":
    case "team.join": {
      if (resource.kind !== "team_work") return refuse("bad_resource", "This action needs an event.");
      if (resource.onTeam) {
        return refuse("already_on_a_team", "You are already on a team in this event; one person, one team.");
      }
      if (!submissionsOpen(resource.event, now)) return windowRefusal(resource.event, now, "Teams can no longer be formed");
      return allow;
    }

    case "team.manage": {
      if (resource.kind !== "team") return refuse("bad_resource", "This action needs a team.");
      return resource.isCaptain ? allow : refuse("not_the_captain", "Only the team's captain can do this.");
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
      if (resource.status === "recused") {
        return refuse("recused", "You declared a conflict on this project, so it is no longer yours to score.");
      }
      return judgingRefusal(resource.event, now) ?? allow;
    }
  }
}
