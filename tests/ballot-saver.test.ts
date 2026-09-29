import { afterEach, describe, expect, it, vi } from "vitest";
import { BallotSaver, isConnectionLost, type SaverView, type SendResult } from "@/app/events/[event]/vote/ballot-saver";

// The ballot's save line (items 2 and 3 of the night's UI pass): picks save one at a
// time and always end on the latest, a lost connection says so and retries, a refusal
// rolls back to what the server holds.

function deferred() {
  let resolve!: (r: SendResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SendResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(initial: string[] = []) {
  const calls: { picks: string[]; answer: ReturnType<typeof deferred> }[] = [];
  const views: SaverView[] = [];
  const saver = new BallotSaver(
    (picks) => {
      const answer = deferred();
      calls.push({ picks, answer });
      return answer.promise;
    },
    (v) => views.push(v),
    initial,
    1000,
    4000,
  );
  return { saver, calls, views, last: () => views.at(-1)! };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("BallotSaver", () => {
  it("sends a second pick made during a save after the first answer, never alongside it", async () => {
    const h = harness();
    h.saver.want(["a"]);
    h.saver.want(["a", "b"]);
    expect(h.calls.map((c) => c.picks)).toEqual([["a"]]);
    expect(h.last()).toEqual({ phase: "saving", picks: ["a", "b"] });
    h.calls[0]!.answer.resolve({ ok: true, picks: ["a"] });
    await tick();
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["a", "b"]]);
    // the first answer does not pull the screen back to ["a"]
    expect(h.views.some((v) => v.phase === "saved" && v.picks.length === 1)).toBe(false);
    h.calls[1]!.answer.resolve({ ok: true, picks: ["a", "b"] });
    await tick();
    expect(h.last()).toEqual({ phase: "saved", picks: ["a", "b"] });
    expect(h.saver.unsaved()).toBe(false);
  });

  it("keeps only the latest of several quick picks for the next save", async () => {
    const h = harness();
    h.saver.want(["a"]);
    h.saver.want(["a", "b"]);
    h.saver.want(["b"]);
    h.calls[0]!.answer.resolve({ ok: true, picks: ["a"] });
    await tick();
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["b"]]);
  });

  it("says a pick is not saved when the connection drops, keeps it on screen and retries", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    h.calls[0]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "offline", picks: ["a"] });
    expect(h.saver.unsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.answer.resolve({ ok: true, picks: ["a"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "saved", picks: ["a"] });
    expect(h.saver.unsaved()).toBe(false);
  });

  it("waits longer after each failed retry, up to the cap", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    for (const wait of [1000, 2000, 4000, 4000]) {
      h.calls.at(-1)!.answer.reject(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
      const before = h.calls.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(h.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.calls.length).toBe(before + 1);
    }
  });

  it("retries at once when asked (back online) and when the voter picks again", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    h.calls[0]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(0);
    h.saver.retryNow();
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(0);
    h.saver.want(["a", "b"]);
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["a"], ["a", "b"]]);
  });

  it("rolls back to what the server holds on a refusal and shows its words", async () => {
    const h = harness(["x"]);
    h.saver.want(["x", "a"]);
    h.saver.want(["x", "a", "b"]);
    h.calls[0]!.answer.resolve({ ok: false, message: "Voting has closed." });
    await tick();
    expect(h.last()).toEqual({ phase: "refused", picks: ["x"], message: "Voting has closed." });
    // the queued change is dropped with it, nothing more is sent
    expect(h.calls).toHaveLength(1);
    expect(h.saver.unsaved()).toBe(false);
  });

  it("stops and says to reload when the server answers with an error, instead of retrying forever", async () => {
    vi.useFakeTimers();
    const h = harness(["x"]);
    h.saver.want(["x", "a"]);
    // what the page gets when the action throws on the server (SQLITE_BUSY, a bug): an Error with a digest
    h.calls[0]!.answer.reject(Object.assign(new Error("An error occurred in the Server Components render."), { digest: "123" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "failed", picks: ["x"] });
    expect(h.saver.unsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });

  it("treats an action the server no longer knows (a new build mid-vote) as a server fault too", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    class UnrecognizedActionError extends Error {}
    h.calls[0]!.answer.reject(new UnrecognizedActionError('Server Action "abc" was not found on the server.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "failed", picks: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });

  it("a pick after a server fault tries again, and a quick pick queued behind the fault is dropped with it", async () => {
    const h = harness();
    h.saver.want(["a"]);
    h.saver.want(["a", "b"]);
    h.calls[0]!.answer.reject(new Error("An unexpected response was received from the server."));
    await tick();
    expect(h.last()).toEqual({ phase: "failed", picks: [] });
    expect(h.calls).toHaveLength(1);
    h.saver.want(["c"]);
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["c"]]);
    h.calls[1]!.answer.resolve({ ok: true, picks: ["c"] });
    await tick();
    expect(h.last()).toEqual({ phase: "saved", picks: ["c"] });
  });

  it("positive control: only a fetch that never answered (TypeError) counts as a lost connection", () => {
    expect(isConnectionLost(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectionLost(new TypeError("Load failed"))).toBe(true);
    expect(isConnectionLost(Object.assign(new Error("x"), { digest: "1" }))).toBe(false);
    expect(isConnectionLost(new Error("An unexpected response was received from the server."))).toBe(false);
    expect(isConnectionLost("nope")).toBe(false);
  });

  it("draws the server's answer when it differs from what was sent", async () => {
    const h = harness();
    h.saver.want(["a", "b"]);
    h.calls[0]!.answer.resolve({ ok: true, picks: ["b", "a"] });
    await tick();
    expect(h.last()).toEqual({ phase: "saved", picks: ["b", "a"] });
  });
});
