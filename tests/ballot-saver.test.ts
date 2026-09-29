import { afterEach, describe, expect, it, vi } from "vitest";
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { BallotSaver, failureKind, type SaverView, type SendResult } from "@/app/events/[event]/vote/ballot-saver";

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
    // Next's own class, as the page gets it after a redeploy with a new build
    h.calls[0]!.answer.reject(new UnrecognizedActionError('Server Action "abc" was not found on the server.'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "failed", picks: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });

  // Follow-up item 1: behind a reverse proxy, a plain restart of the portal makes the proxy answer
  // 502/503/504 with its own page; Next turns that into a plain Error with no digest. The same build
  // comes back with the same action id, so a later try saves the pick.
  const gateway = () => new Error("An unexpected response was received from the server.");

  it("retries an unexpected answer (a proxy's 502 while the portal restarts) and saves once the portal is back", async () => {
    vi.useFakeTimers();
    const h = harness(["x"]);
    h.saver.want(["x", "a"]);
    h.calls[0]!.answer.reject(gateway());
    await vi.advanceTimersByTimeAsync(0);
    // the pick stays on screen, the page says it is still trying
    expect(h.last()).toEqual({ phase: "retrying", picks: ["x", "a"] });
    expect(h.saver.unsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls.map((c) => c.picks)).toEqual([["x", "a"], ["x", "a"]]);
    // a proxy that answers with its own text/plain words is the same kind
    h.calls[1]!.answer.reject(new Error("Bad Gateway"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "retrying", picks: ["x", "a"] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.answer.resolve({ ok: true, picks: ["x", "a"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "saved", picks: ["x", "a"] });
    expect(h.saver.unsaved()).toBe(false);
  });

  it("gives up on unexpected answers after the last try, and says to reload", async () => {
    vi.useFakeTimers();
    const h = harness(["x"]);
    h.saver.want(["x", "a"]);
    // the first answer and six retries on the usual schedule (with this harness: 1, 2, 4, 4, 4, 4 s)
    for (const wait of [1000, 2000, 4000, 4000, 4000, 4000]) {
      h.calls.at(-1)!.answer.reject(gateway());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.last()).toEqual({ phase: "retrying", picks: ["x", "a"] });
      const before = h.calls.length;
      await vi.advanceTimersByTimeAsync(wait);
      expect(h.calls.length).toBe(before + 1);
    }
    expect(h.calls).toHaveLength(7);
    h.calls[6]!.answer.reject(gateway());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "failed", picks: ["x"] });
    expect(h.saver.unsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(7);
  });

  it("with the default schedule the unexpected-answer tries cover about 45 s", async () => {
    vi.useFakeTimers();
    const calls: ReturnType<typeof deferred>[] = [];
    const views: SaverView[] = [];
    const saver = new BallotSaver(
      () => {
        const d = deferred();
        calls.push(d);
        return d.promise;
      },
      (v) => views.push(v),
      [],
    );
    saver.want(["a"]);
    const start = Date.now();
    while (views.at(-1)!.phase !== "failed") {
      calls.at(-1)!.reject(gateway());
      await vi.advanceTimersByTimeAsync(0);
      if (views.at(-1)!.phase === "failed") break;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.length).toBeLessThan(20);
    }
    // 1 + 2 + 4 + 8 + 15 + 15 s of waiting, then the answer to the last try
    expect(calls).toHaveLength(7);
    expect(Date.now() - start).toBe(6 * 20_000);
    expect(views.filter((v) => v.phase === "retrying")).toHaveLength(6);
  });

  it("a new pick while still trying goes out at once and gets the full set of tries again", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    for (let i = 0; i < 5; i++) {
      h.calls.at(-1)!.answer.reject(gateway());
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(h.calls).toHaveLength(6);
    h.calls[5]!.answer.reject(gateway());
    await vi.advanceTimersByTimeAsync(0);
    h.saver.want(["a", "b"]);
    expect(h.calls.map((c) => c.picks).at(-1)).toEqual(["a", "b"]);
    h.calls.at(-1)!.answer.reject(gateway());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "retrying", picks: ["a", "b"] });
  });

  it("a lost connection between unexpected answers keeps retrying and does not use up the tries", async () => {
    vi.useFakeTimers();
    const h = harness(["x"]);
    h.saver.want(["x", "a"]);
    for (let i = 0; i < 6; i++) {
      h.calls.at(-1)!.answer.reject(gateway());
      await vi.advanceTimersByTimeAsync(4000);
    }
    // the portal's port is closed for a while: the browser's fetch fails outright
    for (let i = 0; i < 10; i++) {
      h.calls.at(-1)!.answer.reject(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.last().phase).toBe("offline");
      await vi.advanceTimersByTimeAsync(4000);
    }
    h.calls.at(-1)!.answer.resolve({ ok: true, picks: ["x", "a"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last()).toEqual({ phase: "saved", picks: ["x", "a"] });
  });

  it("a pick after a server fault tries again, and a quick pick queued behind the fault is dropped with it", async () => {
    const h = harness();
    h.saver.want(["a"]);
    h.saver.want(["a", "b"]);
    h.calls[0]!.answer.reject(Object.assign(new Error("An error occurred in the Server Components render."), { digest: "9" }));
    await tick();
    expect(h.last()).toEqual({ phase: "failed", picks: [] });
    expect(h.calls).toHaveLength(1);
    h.saver.want(["c"]);
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["c"]]);
    h.calls[1]!.answer.resolve({ ok: true, picks: ["c"] });
    await tick();
    expect(h.last()).toEqual({ phase: "saved", picks: ["c"] });
  });

  it("sorts each kind of failed call: lost connection, unexpected answer, server fault", () => {
    expect(failureKind(new TypeError("Failed to fetch"))).toBe("connection");
    expect(failureKind(new TypeError("Load failed"))).toBe("connection");
    expect(failureKind(gateway())).toBe("unexpected");
    expect(failureKind(new Error("Service Unavailable"))).toBe("unexpected");
    expect(failureKind(Object.assign(new Error("x"), { digest: "1" }))).toBe("fault");
    expect(failureKind(new UnrecognizedActionError("gone"))).toBe("fault");
    expect(failureKind("nope")).toBe("unexpected");
  });

  it("sends a waiting retry at once when the ballot goes away, and does not keep retrying after", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.want(["a"]);
    h.calls[0]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
    h.saver.leave();
    // the pick is not dropped silently: one last try goes out now
    expect(h.calls.map((c) => c.picks)).toEqual([["a"], ["a"]]);
    h.calls[1]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(2);
  });

  it("keeps retrying after its effect was taken down and put back (React Strict Mode)", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.saver.attach();
    h.saver.leave();
    h.saver.attach();
    h.saver.want(["a"]);
    h.calls[0]!.answer.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saver.unsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
  });

  it("positive control: leaving with nothing waiting sends nothing", async () => {
    const h = harness();
    h.saver.want(["a"]);
    h.calls[0]!.answer.resolve({ ok: true, picks: ["a"] });
    await tick();
    h.saver.leave();
    expect(h.calls).toHaveLength(1);
  });

  it("draws the server's answer when it differs from what was sent", async () => {
    const h = harness();
    h.saver.want(["a", "b"]);
    h.calls[0]!.answer.resolve({ ok: true, picks: ["b", "a"] });
    await tick();
    expect(h.last()).toEqual({ phase: "saved", picks: ["b", "a"] });
  });
});
