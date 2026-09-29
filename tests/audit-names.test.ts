import { describe, expect, it } from "vitest";
import { appendAudit } from "@/server/audit";
import { auditCsv, latestAudit } from "@/server/dal/audit-log";
import { sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The log's sentences name people by their account name wherever a row mentions them: the actor, the target, and
// a person inside the row's before or after (a member taken off a team). Someone whose account is gone, or an id
// that is nobody's, is shown as the id.

const h = withFixtureEvent();
const NOW = "2026-09-26T12:30:00.000Z";

const sentences = () => latestAudit(h().db, "evt_01", 10).map((l) => l.parts.map((p) => p.text).join(""));

describe("people in the audit log's sentences", () => {
  it("are named by their account names: actor, target and a member in the row's before", () => {
    const judge = sqlGet<{ id: string; name: string }>("SELECT u.id, u.name FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'judge' ORDER BY u.id LIMIT 1")!;
    const member = sqlGet<{ id: string; name: string; team: string; teamName: string }>(
      "SELECT u.id, u.name, m.team_id AS team, t.name AS teamName FROM team_members m JOIN users u ON u.id = m.user_id JOIN teams t ON t.id = m.team_id ORDER BY u.id LIMIT 1",
    )!;
    const organizer = sqlGet<{ name: string }>("SELECT name FROM users WHERE id = 'usr_organizer'")!;
    sqlRun("UPDATE users SET name = 'Renamed Organizer' WHERE id = 'usr_organizer'");
    const db = h().db;
    const actor = { actorUserId: "usr_organizer", actorLabel: organizer.name };
    appendAudit(db, { ...actor, action: "judge.override", eventId: "evt_01", targetType: "user", targetId: judge.id, after: { mode: "exclude", reason: "flat scores" } }, NOW);
    appendAudit(db, { ...actor, action: "team.member_removed", eventId: "evt_01", targetType: "team", targetId: member.team, before: { member: member.id } }, NOW);
    appendAudit(db, { ...actor, action: "event.organizer_added", eventId: "evt_01", targetType: "user", targetId: "usr_nobody_here" }, NOW);

    const [added, removed, override] = sentences();
    // the actor by the account's name now, not the label the row was written with
    expect(override).toBe(`Renamed Organizer left out ${judge.name}: “flat scores”`);
    expect(removed).toBe(`Renamed Organizer took ${member.name} off ${member.teamName}`);
    expect(added).toBe("Renamed Organizer made usr_nobody_here an organizer");
    expect(auditCsv(db, "evt_01")).toContain(`Renamed Organizer left out ${judge.name}`);
  });
});
