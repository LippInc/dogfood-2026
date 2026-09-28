import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { users } from "@/server/db/schema";
import { actorForToken, createLoginSession } from "@/server/session";
import { settingsProblem } from "@/server/settings";

// SESSION_DAYS: how long a password sign-in lasts (default 14 days), so an operator can
// cover a month-long judging window. It counts from the sign-in.

const DAY = 86_400_000;
const NOW = new Date("2026-10-01T09:00:00.000Z");
const saved = process.env.SESSION_DAYS;
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  h.db.insert(users).values({ id: "usr_judge", email: "judge@example.org", name: "Judge", createdAt: NOW.toISOString() }).run();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  if (saved === undefined) delete process.env.SESSION_DAYS;
  else process.env.SESSION_DAYS = saved;
});

describe("SESSION_DAYS", () => {
  it("unset, a sign-in lasts 14 days: valid on day 13, gone on day 15", () => {
    delete process.env.SESSION_DAYS;
    const s = createLoginSession(h.db, "usr_judge", NOW);
    expect(s.expires.getTime() - NOW.getTime()).toBe(14 * DAY);
    expect(actorForToken(h.db, s.token, new Date(NOW.getTime() + 13 * DAY))?.userId).toBe("usr_judge");
    expect(actorForToken(h.db, s.token, new Date(NOW.getTime() + 15 * DAY))).toBeNull();
  });

  it("set to 45, a judge signed in on the first day of a month-long window is still signed in on day 40", () => {
    process.env.SESSION_DAYS = "45";
    const s = createLoginSession(h.db, "usr_judge", NOW);
    expect(s.expires.getTime() - NOW.getTime()).toBe(45 * DAY);
    expect(actorForToken(h.db, s.token, new Date(NOW.getTime() + 40 * DAY))?.userId).toBe("usr_judge");
    expect(actorForToken(h.db, s.token, new Date(NOW.getTime() + 46 * DAY))).toBeNull();
  });

  it("boot refuses a value that is not a whole number from 1 to 366", () => {
    for (const bad of ["0", "367", "two weeks", "14.5"]) expect(settingsProblem({ SESSION_DAYS: bad })).toMatch(/SESSION_DAYS must be a whole number from 1 to 366/);
    expect(settingsProblem({ SESSION_DAYS: "30" })).toBeNull();
  });
});
