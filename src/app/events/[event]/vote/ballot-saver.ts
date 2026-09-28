/**
 * Sends a voter's ballot to the server one save at a time, always ending on the
 * latest picks. The page draws `picks` at once (a pick never waits for the network);
 * the saver makes sure what the server holds catches up, and says so when it cannot:
 *
 * - a pick made while a save is on its way is sent right after it, so a quick second
 *   pick is never lost and two saves never race each other to the server;
 * - a lost connection (the call throws) keeps the picks on screen, says they are not
 *   saved yet and tries again, waiting a little longer each time;
 * - a refusal (the server answers, but no) puts the ballot back to what the server
 *   last accepted and shows the server's words.
 */

export type SendResult = { ok: boolean; message?: string | null; picks?: string[] };

export type SaverView =
  | { phase: "idle"; picks: string[] }
  | { phase: "saving"; picks: string[] }
  | { phase: "saved"; picks: string[] }
  | { phase: "offline"; picks: string[] }
  | { phase: "refused"; picks: string[]; message: string };

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
    } catch {
      this.inflight = false;
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
