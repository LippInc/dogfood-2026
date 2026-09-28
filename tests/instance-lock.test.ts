import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_FILE, lockRefusal, STALE_MS, takeLock } from "@/server/instance-lock";

// One portal process per data volume: a second process on the same database refuses to start with a clear
// message, while a restarted container, a clean stop and a lock left by a dead process never block a start.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
});
afterEach(() => {
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
});

const first = { pid: 1, host: "container-a" };

describe("the data folder lock", () => {
  it("positive control: an empty folder is free, and the first process takes it", () => {
    expect(lockRefusal(dir, first)).toBeNull();
    const lock = takeLock(dir, first, false);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true);
    lock.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it("known-bad: a second container on the same volume is refused while the first holds the lock", () => {
    const lock = takeLock(dir, first, false);
    const refusal = lockRefusal(dir, { pid: 1, host: "container-b" });
    expect(refusal).toMatch(/another portal process \(pid 1 on container-a/);
    expect(refusal).toMatch(/stop the other one first/);
    lock.release();
    expect(lockRefusal(dir, { pid: 1, host: "container-b" })).toBeNull(); // a clean stop frees it
  });

  it("known-bad: a second live process on the same machine is refused", () => {
    const lock = takeLock(dir, { pid: process.pid, host: os.hostname() }, false);
    expect(lockRefusal(dir, { pid: process.pid + 1, host: os.hostname() })).toMatch(/another portal process/);
    lock.release();
  });

  it("a restarted container (same host, same pid) takes its own old lock back", () => {
    takeLock(dir, first, false); // the process died without releasing it
    expect(lockRefusal(dir, first)).toBeNull();
  });

  it("a lock left by a process that is gone is taken over: at once on the same machine, after 20 s from elsewhere", () => {
    const gonePid = 2 ** 22 + 12345; // above any pid this machine hands out
    takeLock(dir, { pid: gonePid, host: os.hostname() }, false);
    expect(lockRefusal(dir, { pid: process.pid, host: os.hostname() })).toBeNull();
    const now = Date.now();
    expect(lockRefusal(dir, { pid: 1, host: "container-b" }, now)).toMatch(/another portal process/);
    expect(lockRefusal(dir, { pid: 1, host: "container-b" }, now + STALE_MS + 1_000)).toBeNull();
  });
});
