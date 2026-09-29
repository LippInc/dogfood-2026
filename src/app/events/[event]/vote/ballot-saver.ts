/**
 * Sends a voter's ballot to the server one save at a time, always ending on the
 * latest picks. The page draws `picks` at once (a pick never waits for the network);
 * the saver makes sure what the server holds catches up, and says so when it cannot:
 *
 * - a pick made while a save is on its way is sent right after it, so a quick second
 *   pick is never lost and two saves never race each other to the server;
 * - a lost connection (the request never got an answer) keeps the picks on screen, says
 *   they are not saved yet and tries again, waiting a little longer each time;
 * - a refusal (the server answers, but no) puts the ballot back to what the server
 *   last accepted and shows the server's words;
 * - a server fault (the server answered with an error: a database busy past its timeout,
 *   a bug, or a new build of the portal that no longer knows this page's action) will not
 *   mend by itself, so the saver does not retry: the ballot goes back to what the server
 *   last accepted and the page says the pick was not saved and to reload.
 */

export type SendResult = { ok: boolean; message?: string | null; picks?: string[] };

export type SaverView =
  | { phase: "idle"; picks: string[] }
  | { phase: "saving"; picks: string[] }
  | { phase: "saved"; picks: string[] }
  | { phase: "offline"; picks: string[] }
  | { phase: "refused"; picks: string[]; message: string }
  | { phase: "failed"; picks: string[] };

/**
 * True when a server action's call failed before any answer came back. The browser's fetch
 * rejects with a TypeError then ("Failed to fetch", "Load failed", "NetworkError ..."), also when
 * the connection breaks while the answer is read. Everything else Next hands the page is an
 * answer: an error the action threw (an Error with a digest), an action the server does not
 * know (UnrecognizedActionError), or a response that is not the action's (a plain Error).
 */
export function isConnectionLost(err: unknown): boolean {
  return err instanceof TypeError;
}

export class BallotSaver {
  private desired: string[];
  private saved: string[];
  private inflight = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = 0;

  constructor(
    private readonly send: (picks: string[]) => Promise<SendResult>,
    private readonly onChange: (view: SaverView) => void,
    initial: string[],
    private readonly firstDelay = 1000,
    private readonly maxDelay = 15_000,
  ) {
    this.desired = initial;
    this.saved = initial;
  }

  /** The voter changed their picks: draw them now, save them as soon as the line is free. */
  want(picks: string[]): void {
    this.desired = picks;
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

  /** Stop a waiting retry (the page is going away). */
  stop(): void {
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
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
      if (!isConnectionLost(err)) {
        // The server answered, with an error: retrying the same call will not help. Like a refusal,
        // it answers for the whole ballot, so anything queued behind it goes too.
        this.dirty = false;
        this.delay = 0;
        this.desired = this.saved;
        this.onChange({ phase: "failed", picks: this.saved });
        return;
      }
      if (this.dirty) {
        // a newer pick arrived meanwhile: send that one straight away
        void this.flush();
        return;
      }
      this.delay = Math.min(this.delay ? this.delay * 2 : this.firstDelay, this.maxDelay);
      this.onChange({ phase: "offline", picks: this.desired });
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.delay);
      return;
    }
    this.inflight = false;
    this.delay = 0;
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
    // A refusal answers for the whole ballot: go back to what the server holds and drop anything queued.
    this.dirty = false;
    this.desired = this.saved;
    this.onChange({ phase: "refused", picks: this.saved, message: res.message ?? "Not saved." });
  }
}
