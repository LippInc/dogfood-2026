import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "@/server/rate-limit";
import { sha256 } from "@/server/util";
import { describeVotingCode, enterVoting } from "@/server/dal/voting";
import { expectHttpError, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// An open voting link is found by the hash stored in its event's settings, and only while that event lets
// people vote by link. Both ways in (the preview and the entry) look it up the same way.

withFixtureEvent();

const CODE = "open-link-code-for-the-lookup-test";
const setVoting = (modes: string[], linkHash: string | null) =>
  sqlRun(
    "UPDATE events SET voting_open_at = '2026-01-01T00:00:00.000Z', voting_close_at = '2099-01-01T00:00:00.000Z', settings = json_set(settings, '$.voting', json(?)) WHERE id = 'evt_01'",
    JSON.stringify({ modes, votesPerVoter: 3, linkHash }),
  );

beforeEach(() => resetRateLimits());

describe("finding the event of an open voting link", () => {
  it("finds it by the stored hash, for the preview and for the entry (positive control)", () => {
    setVoting(["link"], sha256(CODE));
    const described = describeVotingCode(CODE, { ip: "10.1.0.1", agent: "A" });
    expect(described.event.id).toBe("evt_01");
    expect(described.kind).toBe("link");
    expect(enterVoting(CODE, { ip: "10.1.0.1", agent: "A" }).eventId).toBe("evt_01");
  });

  it("known-bad: the same hash while the event does not take link votes is 404 on both", () => {
    setVoting(["account"], sha256(CODE));
    expectHttpError(() => describeVotingCode(CODE, { ip: "10.1.0.2", agent: "A" }), 404, "not_found");
    expectHttpError(() => enterVoting(CODE, { ip: "10.1.0.2", agent: "A" }), 404, "not_found");
  });

  it("known-bad: another code, or no link at all, is 404 on both", () => {
    setVoting(["link"], sha256(CODE));
    expectHttpError(() => describeVotingCode(`${CODE}-x`, { ip: "10.1.0.3", agent: "A" }), 404, "not_found");
    expectHttpError(() => enterVoting(`${CODE}-x`, { ip: "10.1.0.3", agent: "A" }), 404, "not_found");
    setVoting(["link"], null);
    expectHttpError(() => describeVotingCode(CODE, { ip: "10.1.0.4", agent: "A" }), 404, "not_found");
  });
});
