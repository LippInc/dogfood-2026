import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/authz";
import { organizer, sqlGet, withFixtureEvent } from "./support/fixture-harness";

// The new-event form with a source chosen sends what the browser sends: the parts a source replaces (team size,
// tracks, prizes) sit in a disabled fieldset, so they are not in the form data at all. The form must still create
// the event; an early build refused it on a hidden "Most people on one team" field the organizer could not see.

withFixtureEvent();

let actor: Actor | null = null;
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/server/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/dal")>()), currentActor: async () => actor }));

describe("the new-event form with a source event chosen", () => {
  it("creates the event from what the browser sends, without the disabled fields", async () => {
    actor = { ...organizer(), isAdmin: true };
    const { createEventAction } = await import("@/app/organize/actions");
    const form = new FormData();
    form.set("sourceEventId", "evt_01");
    form.set("name", "Autumn Hack 2026");
    form.set("slug", "");
    form.set("description", "");
    form.set("submissionsOpenAt", "");
    form.set("submissionsCloseAt", "2026-11-01T18:00");
    form.set("judgingCloseAt", "");
    let outcome: unknown;
    try {
      outcome = await createEventAction({ ok: false, message: null }, form);
    } catch (err) {
      outcome = (err as Error).message;
    }
    expect(outcome).toBe("REDIRECT /organize/autumn-hack-2026");
    const settings = JSON.parse(sqlGet<{ settings: string }>("SELECT settings FROM events WHERE slug = 'autumn-hack-2026'")!.settings);
    const source = JSON.parse(sqlGet<{ settings: string }>("SELECT settings FROM events WHERE id = 'evt_01'")!.settings);
    expect(settings.maxTeamSize).toBe(source.maxTeamSize);
  });
});
