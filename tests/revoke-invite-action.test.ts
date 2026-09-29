import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { createLoginSession } from "@/server/session";
import { inviteJudge } from "@/server/dal/judges";
import { actorForToken } from "@/server/session";

// The Judges page's Revoke button. Its action used to swallow a refusal: an invitation accepted
// while the page was open answered 409 invite_used, the page reloaded, and the organizer saw the
// row turn into "accepted" with no word why. It now answers like the page's other actions.

let token: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && token ? { value: token } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { revokeInviteAction } = await import("@/app/organize/[event]/judges/actions");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  token = createLoginSession(h.db, "usr_organizer").token;
});

afterEach(() => {
  token = null;
  setHandleForTests(null);
  h.sqlite.close();
});

function invite() {
  const organizer = actorForToken(h.db, token!)!;
  const id = (inviteJudge(organizer, "evt_01", { name: "Late Judge", email: "", trackIds: ["trk_01"] }) as { id: string }).id;
  const form = new FormData();
  form.set("event", "sample-hack-2026");
  form.set("invite", id);
  return { id, form };
}
const revokedAt = (id: string) => (h.sqlite.prepare("SELECT revoked_at AS r FROM judge_invites WHERE id = ?").get(id) as { r: string | null }).r;

describe("revokeInviteAction", () => {
  it("known-bad: an invitation accepted in the meantime answers the 409's words, not silence", async () => {
    const { id, form } = invite();
    h.sqlite.prepare("UPDATE judge_invites SET accepted_at = ?, accepted_by = 'jdg_01' WHERE id = ?").run(NOW, id);
    const out = await revokeInviteAction({ ok: false, message: null }, form);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toContain("already accepted");
    expect(revokedAt(id)).toBeNull();
  });

  it("known-bad: someone who is not the event's organizer is told so", async () => {
    const { form } = invite();
    token = createLoginSession(h.db, "jdg_01").token;
    const out = await revokeInviteAction({ ok: false, message: null }, form);
    expect(out.ok).toBe(false);
    expect(out.message).toBeTruthy();
  });

  it("positive control: an open invitation is revoked and the answer is ok", async () => {
    const { id, form } = invite();
    const out = await revokeInviteAction({ ok: false, message: null }, form);
    expect(out.ok).toBe(true);
    expect(revokedAt(id)).not.toBeNull();
  });
});
