import { describe, expect, it } from "vitest";
import { authorize, type Actor, type Decision, type EventFacts } from "@/server/authz";

// Pure: actors and facts are built by hand, and `now` is passed explicitly everywhere.

const NOW = new Date("2026-03-02T00:00:00Z"); // after submissions closed, nothing else set

const actor = (userId: string, email: string, roles: Actor["roles"]): Actor => ({
  userId,
  name: userId.toUpperCase(),
  email,
  isAdmin: false,
  roles,
  sessionKind: "login",
});

const judgeX = actor("jdg_1", "j1@example.org", [{ eventId: "evt_x", role: "judge" }]);
const judgeColleague = actor("jdg_9", "j9@example.org", [{ eventId: "evt_x", role: "judge" }]);
const judgeElsewhere = actor("jdg_2", "j2@example.org", [{ eventId: "evt_other", role: "judge" }]);
const organizerX = actor("usr_org", "org@example.org", [{ eventId: "evt_x", role: "organizer" }]);
const exJudge = actor("jdg_1", "j1@example.org", [{ eventId: "evt_x", role: "participant" }]);
const ada = actor("usr_ada", "Ada@Example.org", []);
const someoneElse = actor("usr_other", "other@example.org", []);

const event = (facts: Partial<EventFacts> = {}): EventFacts => ({
  id: "evt_x",
  submissionsOpenAt: null,
  submissionsCloseAt: "2026-03-01T18:00:00Z",
  resultsPublishedAt: null,
  judgingCloseAt: null,
  ...facts,
});

const invite = (email: string | null) => ({ kind: "judge_invite" as const, event: event(), email });

const assignment = (
  facts: Partial<EventFacts> = {},
  judgeUserId = "jdg_1",
  status: "pending" | "done" | "recused" = "pending",
  inJudgeTracks = true,
) => ({ kind: "assignment" as const, id: "asg_1", event: event(facts), judgeUserId, status, inJudgeTracks });

function expectRefusal(decision: Decision, status: 401 | 403, code: string) {
  expect(decision.ok).toBe(false);
  if (decision.ok) throw new Error("unreachable: narrowing guard");
  expect(decision.status).toBe(status);
  expect(decision.code).toBe(code);
}

describe("authorize: judging (pure)", () => {
  describe("judge.accept_invite", () => {
    it("refuses a missing session with 401", () => {
      expectRefusal(authorize(null, "judge.accept_invite", invite("ada@example.org"), NOW), 401, "unauthenticated");
    });

    it("lets anyone use an open link (email: null)", () => {
      expect(authorize(ada, "judge.accept_invite", invite(null), NOW).ok).toBe(true);
      expect(authorize(someoneElse, "judge.accept_invite", invite(null), NOW).ok).toBe(true);
    });

    it("matches the invitation email case-insensitively", () => {
      expect(authorize(ada, "judge.accept_invite", invite("ada@example.org"), NOW).ok).toBe(true);
    });

    it("refuses a signed-in user with another address with invite_for_someone_else", () => {
      expectRefusal(
        authorize(someoneElse, "judge.accept_invite", invite("ada@example.org"), NOW),
        403,
        "invite_for_someone_else",
      );
    });
  });

  describe("judging.console", () => {
    const open = (a: Actor | null) => authorize(a, "judging.console", { kind: "event", event: event() }, NOW);

    it("lets a judge of this event open the console", () => {
      expect(open(judgeX).ok).toBe(true);
    });

    it("refuses a judge of another event with not_a_judge_here", () => {
      expectRefusal(open(judgeElsewhere), 403, "not_a_judge_here");
    });

    it("refuses an organizer of this event without the judge role with not_a_judge_here", () => {
      expectRefusal(open(organizerX), 403, "not_a_judge_here");
    });
  });

  for (const action of ["review.save", "review.recuse"] as const) {
    describe(action, () => {
      const act = (a: Actor | null, resource = assignment(), now: Date = NOW) => authorize(a, action, resource, now);

      it("lets the assigned judge work a pending assignment (positive control)", () => {
        expect(act(judgeX).ok).toBe(true);
      });

      it("refuses another judge of the same event with not_your_assignment", () => {
        expectRefusal(act(judgeColleague), 403, "not_your_assignment");
      });

      it("refuses the assigned user who lost the judge role with not_a_judge_here", () => {
        expectRefusal(act(exJudge), 403, "not_a_judge_here");
      });

      it("refuses a recused assignment with recused", () => {
        expectRefusal(act(judgeX, assignment({}, "jdg_1", "recused")), 403, "recused");
      });

      it("refuses before submissions close with judging_not_open", () => {
        expectRefusal(act(judgeX, assignment(), new Date("2026-02-20T12:00:00Z")), 403, "judging_not_open");
      });

      it("refuses after results are published with results_published", () => {
        expectRefusal(act(judgeX, assignment({ resultsPublishedAt: "2026-03-01T20:00:00Z" })), 403, "results_published");
      });

      it("refuses after judging_close_at with judging_closed, and allows the day before", () => {
        const withClose = assignment({ judgingCloseAt: "2026-03-05T00:00:00Z" });
        expectRefusal(act(judgeX, withClose, new Date("2026-03-06T00:00:00Z")), 403, "judging_closed");
        expect(act(judgeX, withClose, new Date("2026-03-04T00:00:00Z")).ok).toBe(true);
      });

      it("refuses a missing session with 401", () => {
        expectRefusal(act(null), 401, "unauthenticated");
      });
    });
  }

  describe("known-bad: the refusal table — no refusal path returns ok", () => {
    const refusals: { name: string; run: () => Decision }[] = [
      {
        name: "accept_invite: no session",
        run: () => authorize(null, "judge.accept_invite", invite("ada@example.org"), NOW),
      },
      {
        name: "accept_invite: someone else's address",
        run: () => authorize(someoneElse, "judge.accept_invite", invite("ada@example.org"), NOW),
      },
      {
        name: "console: judge of another event",
        run: () => authorize(judgeElsewhere, "judging.console", { kind: "event", event: event() }, NOW),
      },
      {
        name: "console: organizer without the judge role",
        run: () => authorize(organizerX, "judging.console", { kind: "event", event: event() }, NOW),
      },
      ...(["review.save", "review.recuse"] as const).flatMap((action) => [
        { name: `${action}: no session`, run: () => authorize(null, action, assignment(), NOW) },
        { name: `${action}: another judge`, run: () => authorize(judgeColleague, action, assignment(), NOW) },
        { name: `${action}: lost judge role`, run: () => authorize(exJudge, action, assignment(), NOW) },
        {
          name: `${action}: recused`,
          run: () => authorize(judgeX, action, assignment({}, "jdg_1", "recused"), NOW),
        },
        {
          name: `${action}: project outside the judge's tracks`,
          run: () => authorize(judgeX, action, assignment({}, "jdg_1", "pending", false), NOW),
        },
        {
          name: `${action}: before submissions close`,
          run: () => authorize(judgeX, action, assignment(), new Date("2026-02-20T12:00:00Z")),
        },
        {
          name: `${action}: results published`,
          run: () => authorize(judgeX, action, assignment({ resultsPublishedAt: "2026-03-01T20:00:00Z" }), NOW),
        },
        {
          name: `${action}: after judging_close_at`,
          run: () => authorize(judgeX, action, assignment({ judgingCloseAt: "2026-03-05T00:00:00Z" }), new Date("2026-03-06T00:00:00Z")),
        },
      ]),
    ];
    const allows: { name: string; run: () => Decision }[] = [
      { name: "accept_invite: open link", run: () => authorize(ada, "judge.accept_invite", invite(null), NOW) },
      { name: "accept_invite: matching email", run: () => authorize(ada, "judge.accept_invite", invite("ada@example.org"), NOW) },
      { name: "console: this event's judge", run: () => authorize(judgeX, "judging.console", { kind: "event", event: event() }, NOW) },
      { name: "review.save: the assigned judge", run: () => authorize(judgeX, "review.save", assignment(), NOW) },
      { name: "review.recuse: the assigned judge", run: () => authorize(judgeX, "review.recuse", assignment(), NOW) },
    ];

    it("every refusal above refuses, and every allow allows, so the table is not vacuous", () => {
      expect(refusals.filter((c) => c.run().ok !== false).map((c) => c.name)).toEqual([]);
      expect(allows.filter((c) => c.run().ok !== true).map((c) => c.name)).toEqual([]);
      expect(refusals.length).toBeGreaterThanOrEqual(18);
    });
  });
});

describe("a track judge never sees another track", () => {
  it("refuses a project outside the judge's tracks with outside_your_tracks, and allows the same assignment in-track", () => {
    for (const action of ["review.save", "review.recuse"] as const) {
      expectRefusal(authorize(judgeX, action, assignment({}, "jdg_1", "pending", false), NOW), 403, "outside_your_tracks");
      expect(authorize(judgeX, action, assignment({}, "jdg_1", "pending", true), NOW).ok).toBe(true);
    }
  });
});
