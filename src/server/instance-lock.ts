import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One portal process per data volume. Several limits (rate limits, team size, accepting an invite and more) hold
// because one process runs its synchronous transactions one at a time; two processes on one database file can both
// pass a check before either writes. So at start the portal takes portal.lock next to the database and refreshes it
// every 5 s; a second process that finds a fresh lock held by someone else refuses to start and says why. A lock
// left by a process that died is taken over once it is 20 s old (at once when its process is known to be gone), and
// a clean stop (docker compose stop or down, Ctrl-C) removes it.

export const LOCK_FILE = "portal.lock";
const BEAT_MS = 5_000;
export const STALE_MS = 20_000;

type Holder = { id: string; pid: number; host: string; startedAt: string };
export type Me = { pid: number; host: string };

function readHolder(file: string): { holder: Holder | null; mtimeMs: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  try {
    return { holder: JSON.parse(fs.readFileSync(file, "utf8")) as Holder, mtimeMs: stat.mtimeMs };
  } catch {
    return { holder: null, mtimeMs: stat.mtimeMs };
  }
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Why this process may not use the data folder, or null. A lock is someone else's while it is fresh (refreshed in
 * the last 20 s) and names another process: another host (another container on the same volume), or another live
 * process on this one. A container that restarts keeps its host name and runs as the same process id, so it takes
 * its own old lock back.
 */
export function lockRefusal(dir: string, me: Me, now = Date.now()): string | null {
  const found = readHolder(path.join(dir, LOCK_FILE));
  if (!found || now - found.mtimeMs > STALE_MS) return null;
  const h = found.holder;
  if (!h) return null;
  if (h.host === me.host && (h.pid === me.pid || processGone(h.pid))) return null;
  return (
    `another portal process (pid ${h.pid} on ${h.host}, started ${h.startedAt}) is using ${dir}. Two processes on one ` +
    `database are not safe: stop the other one first. If none is running, its lock (${LOCK_FILE}) is taken over ` +
    `${Math.ceil(STALE_MS / 1000)} s after it was last refreshed`
  );
}

export type LockHandle = { release: () => void; file: string; id: string };

/** Take the lock (the caller has checked lockRefusal) and keep it fresh until the process exits. */
export function takeLock(dir: string, me: Me, beat = true): LockHandle {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const holder: Holder = { id: crypto.randomUUID(), pid: me.pid, host: me.host, startedAt: new Date().toISOString() };
  const tmp = `${file}.${holder.id}`;
  fs.writeFileSync(tmp, JSON.stringify(holder));
  fs.renameSync(tmp, file);
  const mine = () => readHolder(file)?.holder?.id === holder.id;
  const timer = beat
    ? setInterval(() => {
        try {
          if (mine()) {
            const t = new Date();
            fs.utimesSync(file, t, t);
          }
        } catch {
          // a full or read-only volume: the health check reports it
        }
      }, BEAT_MS)
    : null;
  timer?.unref();
  const release = () => {
    if (timer) clearInterval(timer);
    try {
      if (mine()) fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
  return { release, file, id: holder.id };
}

/** At start: refuse (with the reason) or take the lock and remove it again when the process exits. */
export function claimDataFolder(dir: string): string | null {
  const me: Me = { pid: process.pid, host: os.hostname() };
  const refused = lockRefusal(dir, me);
  if (refused) return refused;
  const lock = takeLock(dir, me);
  process.once("exit", lock.release);
  return null;
}
