import { describe, expect, it } from "vitest";
import { signUp } from "@/server/dal/accounts";
import { createTeam, makeCaptain } from "@/server/dal/teams";
import { actorById, count, expectHttpError, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A body that fails its schema is a 422 whose message says what the form was about and whose details name the
// fields, and nothing is written. Pins the three messages the team and sign-up actions give.

withFixtureEvent();

const details = (err: unknown) => (err as { details?: Record<string, string[]> }).details ?? {};

describe("422s from a body that fails its schema", () => {
  it("a team name that is too long: 'The team is not valid.', on the name field", () => {
    sqlRun("UPDATE events SET submissions_close_at = '2099-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    sqlRun("INSERT INTO users (id, email, name, created_at) VALUES ('usr_new', 'new@example.org', 'New Person', '2026-09-26T12:00:00.000Z')");
    const teams = count("SELECT count(*) AS n FROM teams");
    const err = expectHttpError(() => createTeam(actorById("usr_new"), "evt_01", { name: "x".repeat(61) }), 422, "invalid");
    expect(err.message).toBe("The team is not valid.");
    expect(Object.keys(details(err))).toEqual(["name"]);
    expect(count("SELECT count(*) AS n FROM teams")).toBe(teams);
  });

  it("a captain change naming nobody: 'Name the member who becomes captain.', on userId", () => {
    sqlRun("UPDATE events SET submissions_close_at = '2099-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    const captain = sqlGet<{ userId: string; teamId: string }>("SELECT user_id AS userId, team_id AS teamId FROM team_members WHERE role = 'captain' ORDER BY team_id LIMIT 1")!;
    const err = expectHttpError(() => makeCaptain(actorById(captain.userId), captain.teamId, {}), 422, "invalid");
    expect(err.message).toBe("Name the member who becomes captain.");
    expect(Object.keys(details(err))).toEqual(["userId"]);
  });

  it("a sign-up with a short password: 'Check the highlighted fields.', on password", async () => {
    const users = count("SELECT count(*) AS n FROM users");
    let caught: unknown;
    try {
      await signUp({ name: "Someone", email: "someone@example.org", password: "short" });
    } catch (e) {
      caught = e;
    }
    expect((caught as { status?: number }).status).toBe(422);
    expect((caught as Error).message).toBe("Check the highlighted fields.");
    expect(Object.keys(details(caught))).toEqual(["password"]);
    expect(count("SELECT count(*) AS n FROM users")).toBe(users);
  });
});
