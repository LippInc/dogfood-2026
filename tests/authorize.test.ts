import { describe, expect, it } from "vitest";
import { authorize, submissionsOpen, type Actor, type Decision, type EventFacts } from "@/server/authz";

// Pure: every fact is built by hand, and `now` is passed explicitly everywhere.

const NOW = new Date("2026-09-26T12:00:00Z");

const judgeA: Actor = {
  userId: "jdg_24",
  name: "A",
  email: "a@x.org",
  isAdmin: false,
  roles: [{ eventId: "evt_01", role: "judge" }],
  sessionKind: "checker",
};
const judgeB: Actor = { ...judgeA, userId: "jdg_26", name: "B", email: "b@x.org" };
const participant: Actor = {
  userId: "usr_123",
  name: "P",
  email: "p@x.org",
  isAdmin: false,
  roles: [{ eventId: "evt_01", role: "participant" }],
  sessionKind: "checker",
};
const organizer: Actor = {
  userId: "usr_org",
  name: "O",
  email: "o@x.org",
  isAdmin: true,
  roles: [{ eventId: "evt_01", role: "organizer" }],
  sessionKind: "checker",
};
const organizerElsewhere: Actor = {
  userId: "usr_other",
  name: "O2",
  email: "o2@x.org",
  isAdmin: true,
  roles: [{ eventId: "evt_99", role: "organizer" }],
  sessionKind: "checker",
};

const closedEvent: EventFacts = {
  id: "evt_01",
  submissionsOpenAt: null,
  submissionsCloseAt: "2026-03-01T18:00:00Z",
  resultsPublishedAt: null,
};
const openEvent: EventFacts = { ...closedEvent, submissionsCloseAt: "2999-01-01T00:00:00Z" };
const notYetOpenEvent: EventFacts = {
  id: "evt_01",
  submissionsOpenAt: "2999-01-01T00:00:00Z",
  submissionsCloseAt: "2999-06-01T00:00:00Z",
  resultsPublishedAt: null,
};

function expectRefusal(decision: Decision, status: 401 | 403, code: string) {
  expect(decision.ok).toBe(false);
  if (decision.ok) throw new Error("unreachable: narrowing guard");
  expect(decision.status).toBe(status);
  expect(decision.code).toBe(code);
}

const teamWork = (event: EventFacts, onTeam: boolean) => ({ kind: "team_work" as const, event, onTeam });

describe("authorize (pure)", () => {
  describe("scores.read_judge", () => {
    const read = (actor: Actor | null) =>
      authorize(actor, "scores.read_judge", { kind: "judge_scores", judgeUserId: "jdg_24" }, NOW);

    it("lets a judge read their own scores", () => {
      expect(read(judgeA).ok).toBe(true);
    });

    it("refuses another judge with not_your_scores — never a fallback to the caller's own rows", () => {
      const decision = read(judgeB);
      expectRefusal(decision, 403, "not_your_scores");
      expect(decision.ok).toBe(false);
    });

    it("refuses a participant and an organizer with not_a_judge", () => {
      expectRefusal(read(participant), 403, "not_a_judge");
      expectRefusal(read(organizer), 403, "not_a_judge");
    });

    it("refuses a missing session with 401", () => {
      expectRefusal(read(null), 401, "unauthenticated");
    });
  });

  describe("scores.read_own", () => {
    const read = (actor: Actor | null) => authorize(actor, "scores.read_own", { kind: "platform" }, NOW);

    it("lets any judge read their own scores", () => {
      expect(read(judgeA).ok).toBe(true);
      expect(read(judgeB).ok).toBe(true);
    });

    it("refuses a participant with not_a_judge", () => {
      expectRefusal(read(participant), 403, "not_a_judge");
    });

    it("refuses a missing session with 401", () => {
      expectRefusal(read(null), 401, "unauthenticated");
    });
  });

  describe("project.create", () => {
    const cases: { name: string; event: EventFacts; onTeam: boolean; refused?: [401 | 403, string] }[] = [
      { name: "team member while the event is closed", event: closedEvent, onTeam: true, refused: [403, "submissions_closed"] },
      { name: "team member while the event is open", event: openEvent, onTeam: true },
      { name: "team member before submissions open", event: notYetOpenEvent, onTeam: true, refused: [403, "submissions_not_open"] },
      { name: "outsider while the event is open", event: openEvent, onTeam: false, refused: [403, "not_on_a_team"] },
      { name: "outsider while the event is closed: the team check comes first", event: closedEvent, onTeam: false, refused: [403, "not_on_a_team"] },
    ];

    for (const c of cases) {
      it(`${c.name} → ${c.refused ? `${c.refused[0]} ${c.refused[1]}` : "ok"}`, () => {
        const decision = authorize(participant, "project.create", teamWork(c.event, c.onTeam), NOW);
        if (c.refused) expectRefusal(decision, c.refused[0], c.refused[1]);
        else expect(decision.ok).toBe(true);
      });
    }

    it("refuses a missing session with 401", () => {
      expectRefusal(authorize(null, "project.create", teamWork(openEvent, true), NOW), 401, "unauthenticated");
    });
  });

  describe("project.edit", () => {
    it("refuses a team member once submissions closed", () => {
      expectRefusal(authorize(participant, "project.edit", teamWork(closedEvent, true), NOW), 403, "submissions_closed");
    });

    it("lets a team member edit while the event is open", () => {
      expect(authorize(participant, "project.edit", teamWork(openEvent, true), NOW).ok).toBe(true);
    });

    it("refuses an outsider with not_your_project, before the window check runs", () => {
      expectRefusal(authorize(participant, "project.edit", teamWork(closedEvent, false), NOW), 403, "not_your_project");
    });
  });

  describe("event.manage and event.export", () => {
    for (const action of ["event.manage", "event.export"] as const) {
      const act = (actor: Actor | null) => authorize(actor, action, { kind: "event", event: closedEvent }, NOW);

      it(`${action}: the event's organizer passes`, () => {
        expect(act(organizer).ok).toBe(true);
      });

      it(`${action}: a judge, a participant and an organizer of another event are refused`, () => {
        expectRefusal(act(judgeA), 403, "not_an_organizer");
        expectRefusal(act(participant), 403, "not_an_organizer");
        expectRefusal(act(organizerElsewhere), 403, "not_an_organizer");
      });

      it(`${action}: a missing session is 401`, () => {
        expectRefusal(act(null), 401, "unauthenticated");
      });
    }
  });

  describe("event.create", () => {
    it("lets an admin create events", () => {
      expect(authorize(organizer, "event.create", { kind: "platform" }, NOW).ok).toBe(true);
    });

    it("refuses everyone else with not_an_admin", () => {
      expectRefusal(authorize(judgeA, "event.create", { kind: "platform" }, NOW), 403, "not_an_admin");
      expectRefusal(authorize(participant, "event.create", { kind: "platform" }, NOW), 403, "not_an_admin");
    });

    it("refuses a missing session with 401", () => {
      expectRefusal(authorize(null, "event.create", { kind: "platform" }, NOW), 401, "unauthenticated");
    });
  });

  describe("submissionsOpen", () => {
    it("treats the close instant as already closed: the window is [open, close)", () => {
      expect(submissionsOpen(closedEvent, new Date("2026-03-01T18:00:00Z"))).toBe(false);
    });

    it("is still open one millisecond before the close instant", () => {
      expect(submissionsOpen(closedEvent, new Date("2026-03-01T17:59:59.999Z"))).toBe(true);
    });
  });

  describe("known-bad: the peer-scores case catches a fallback policy", () => {
    it("a policy that okays any judge disagrees with authorize on judge_b reading judge_a's scores", () => {
      // A deliberately broken policy: any judge may read any judge's scores.
      const leakyAuthorize = (actor: Actor | null): Decision =>
        actor && actor.roles.some((r) => r.role === "judge")
          ? { ok: true }
          : { ok: false, status: 403, code: "leaky_refusal", message: "" };

      const leaky = leakyAuthorize(judgeB);
      const real = authorize(judgeB, "scores.read_judge", { kind: "judge_scores", judgeUserId: "jdg_24" }, NOW);

      expect(leaky.ok).toBe(true); // the broken policy lets judge_b through
      expect(real.ok).toBe(false); // the real one must refuse
      expect(leaky.ok).not.toBe(real.ok);
    });
  });
});
