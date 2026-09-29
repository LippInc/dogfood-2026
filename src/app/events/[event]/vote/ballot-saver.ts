/**
 * Sends a voter's ballot to the server one save at a time, always ending on the
 * latest picks. The page draws `picks` at once (a pick never waits for the network);
 * the saver makes sure what the server holds catches up, and says so when it cannot:
 *
 * - a pick made while a save is on its way is sent right after it, so a quick second
 *   pick is never lost and two saves never race each other to the server;
 * - a lost connection (the request never got an answer) keeps the picks on screen, says
 *   they are not saved yet and tries again, waiting a little longer each time;
 * - an unexpected answer (something answered, but not with the action's reply: a reverse
 *   proxy's 502/503/504 page while the portal restarts) may be gone in a moment, so the saver
 *   keeps the picks on screen, says it is still trying and tries again on the same schedule,
 *   `unexpectedTries` times (with the default schedule 1 + 2 + 4 + 8 + 15 + 15 s, about 45 s),
 *   before it gives up like a server fault;
 * - a refusal (the server answers, but no) puts the ballot back to what the server
 *   last accepted and shows the server's words;
 * - a server fault (the action itself threw: a database busy past its timeout, a bug; or a
 *   new build of the portal that no longer knows this page's action) will not mend by itself,
 *   so the saver does not retry: the ballot goes back to what the server last accepted and the
 *   page says the pick was not saved and to reload.
 */

export type SendResult = { ok: boolean; message?: string | null; picks?: string[] };

export type SaverView =
  | { phase: "idle"; picks: string[] }
  | { phase: "saving"; picks: string[] }
  | { phase: "saved"; picks: string[] }
  | { phase: "offline"; picks: string[] }
  | { phase: "retrying"; picks: string[] }
  | { phase: "refused"; picks: string[]; message: string }
  | { phase: "failed"; picks: string[] };

/**
 * What kind of failure a server action's call ended in, from what Next hands the page:
 * - "connection": the browser's fetch rejected before any answer came back (a TypeError:
 *   "Failed to fetch", "Load failed", "NetworkError ..."), also when the connection breaks
 *   while the answer is read;
 * - "fault": the portal itself answered that the action failed: an error the action threw
 *   (an Error with a digest), or an action this build does not know (UnrecognizedActionError,
 *   after a redeploy with a new build);
 * - "unexpected": anything else, above all the plain Error Next throws when the response is
 *   not an action's reply ("An unexpected response was received from the server.", or a
 *   text/plain error body's words), which is what a reverse proxy's 502/503/504 turns into.
 */
export type FailureKind = "connection" | "unexpected" | "fault";

export function failureKind(err: unknown): FailureKind {
  if (err instanceof TypeError) return "connection";
  if (err instanceof Error) {
    if (typeof (err as { digest?: unknown }).digest === "string") return "fault";
    if (err.name === "UnrecognizedActionError") return "fault";
  }
  return "unexpected";
}

export class BallotSaver {
  private desired: string[];
  private saved: string[];
  private inflight = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = 0;
  private left = false;
  /** unexpected answers in a row for the current picks */
  private unexpected = 0;

  constructor(
    private readonly send: (picks: string[]) => Promise<SendResult>,
    private readonly onChange: (view: SaverView) => void,
    initial: string[],
    private readonly firstDelay = 1000,
    private readonly maxDelay = 15_000,
    private readonly unexpectedTries = 6,
  ) {
    this.desired = initial;
    this.saved = initial;
  }

  /** The voter changed their picks: draw them now, save them as soon as the line is free. */
  want(picks: string[]): void {
    this.desired = picks;
    this.unexpected = 0;
    this.clearTimer();
    this.onChange({ phase: "saving", picks });
    if (this.inflight) this.dirty = true;
    else void this.flush();
  }

  /** Try a waiting save now (the browser says it is back online). */
  retryNow(): void {
    if (this.timer === null) return;
    this.clearTimer();
    void this.flush();
  }

  /** True while the server does not hold what the page shows. */
  unsaved(): boolean {
    return this.inflight || this.dirty || this.timer !== null;
  }

  /**
   * The ballot is on screen (again): retries run as usual. React may take effects down and put
   * them back without the ballot going anywhere (Strict Mode, a hidden Activity), so every
   * leave() is undone by the next attach().
   */
  attach(): void {
    this.left = false;
  }

  /**
   * The ballot is going away (the voter moved to another page). A retry that was waiting goes
   * out now instead of being dropped; after that the saver makes no more retries, since
   * nothing is left on screen to say how they went.
   */
  leave(): void {
    this.left = true;
    if (this.timer === null) return;
    this.clearTimer();
    void this.flush();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Back to what the server last accepted, dropping anything queued: its answer covers the whole ballot. */
  private giveUp(view: "failed" | "refused", message?: string) {
    this.dirty = false;
    this.delay = 0;
    this.unexpected = 0;
    this.desired = this.saved;
    if (view === "refused") this.onChange({ phase: "refused", picks: this.saved, message: message ?? "Not saved." });
    else this.onChange({ phase: "failed", picks: this.saved });
  }

  private async flush(): Promise<void> {
    this.inflight = true;
    this.dirty = false;
    const sent = this.desired;
    let res: SendResult;
    try {
      res = await this.send(sent);
    } catch (err) {
      this.inflight = false;
      const kind = failureKind(err);
      // The portal answered that the action failed: retrying the same call will not help.
      if (kind === "fault") return this.giveUp("failed");
      if (this.dirty) {
        // a newer pick arrived meanwhile: send that one straight away (with its own set of tries)
        void this.flush();
        return;
      }
      // an unexpected answer is tried again only so often: past that it is a fault that did not mend
      if (kind === "unexpected" && ++this.unexpected > this.unexpectedTries) return this.giveUp("failed");
      this.delay = Math.min(this.delay ? this.delay * 2 : this.firstDelay, this.maxDelay);
      this.onChange({ phase: kind === "connection" ? "offline" : "retrying", picks: this.desired });
      if (this.left) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delay);
      return;
    }
    this.inflight = false;
    this.delay = 0;
    this.unexpected = 0;
    if (res.ok) {
      this.saved = res.picks ?? sent;
      if (this.dirty) {
        void this.flush();
        return;
      }
      this.desired = this.saved;
      this.onChange({ phase: "saved", picks: this.saved });
      return;
    }
    this.giveUp("refused", res.message ?? undefined);
  }
}
