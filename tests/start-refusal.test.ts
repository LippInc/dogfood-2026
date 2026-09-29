import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot } from "@/server/boot";
import { DEFAULT_SEED_SECRET, startRefusal } from "@/server/checker";

// The public default DOGFOOD_SEED_SECRET seals the signing key and salts the voters' address hashes, so a
// portal that others can reach must not run on it, demo mode or not: judge's-eye reading 6 found that
// nothing refused it once demo mode was off. Reading 9 found that a portal behind a reverse proxy, with
// PUBLIC_URL unset, still ran on it: so outside demo mode it is refused whatever PUBLIC_URL says, and only the
// local demo (the judges' `docker compose up`, SEED_CHECKER_SESSIONS=true on this machine's own address) keeps it.

const HUB = "https://hack.example.org";
/** An environment holding only the settings named (the type also wants NODE_ENV, which the refusal never reads). */
const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv;

describe("startRefusal", () => {
  it("refuses a non-local PUBLIC_URL with the default secret, none, or an empty one, demo mode or not", () => {
    for (const secret of [undefined, "", DEFAULT_SEED_SECRET]) {
      for (const demo of [undefined, "true", "false"]) {
        expect(startRefusal(env({ PUBLIC_URL: HUB, DOGFOOD_SEED_SECRET: secret, SEED_CHECKER_SESSIONS: demo }))).toMatch(/not a local address.*set DOGFOOD_SEED_SECRET/);
      }
    }
    expect(startRefusal(env({ PUBLIC_URL: "http://192.168.1.20:8080" }))).toMatch(/not a local address/); // a LAN address is reachable too
    expect(startRefusal(env({ PUBLIC_URL: "not a url" }))).toMatch(/not a local address/);
  });

  it("lets an operator's own secret start anywhere, demo mode or not", () => {
    for (const demo of [undefined, "true", "false"]) {
      for (const url of [HUB, undefined, "http://localhost:8080"]) {
        expect(startRefusal(env({ PUBLIC_URL: url, DOGFOOD_SEED_SECRET: "an operator's own secret", SEED_CHECKER_SESSIONS: demo }))).toBeNull();
      }
    }
  });

  it("lets the default start the local demo (SEED_CHECKER_SESSIONS=true, the shipped compose file) on this machine's own address", () => {
    for (const local of [undefined, "http://localhost:8080", "http://127.0.0.1:8096", "http://[::1]:8080", "http://portal.localhost"]) {
      expect([local, startRefusal(env({ PUBLIC_URL: local, DOGFOOD_SEED_SECRET: DEFAULT_SEED_SECRET, SEED_CHECKER_SESSIONS: "true" }))]).toEqual([local, null]);
    }
  });

  it("refuses the default secret, or none, with demo mode off, whatever PUBLIC_URL says (unset: a portal behind a reverse proxy)", () => {
    for (const secret of [undefined, "", DEFAULT_SEED_SECRET]) {
      for (const demo of [undefined, "false", "TRUE"]) {
        for (const local of [undefined, "http://localhost:8080", "http://portal.localhost"]) {
          expect(startRefusal(env({ PUBLIC_URL: local, DOGFOOD_SEED_SECRET: secret, SEED_CHECKER_SESSIONS: demo }))).toMatch(
            /demo mode is off.*set DOGFOOD_SEED_SECRET to a long random string of your own/,
          );
        }
      }
    }
  });
});

describe("boot with the default secret outside the local demo", () => {
  const saved = { url: process.env.PUBLIC_URL, secret: process.env.DOGFOOD_SEED_SECRET, db: process.env.DATABASE_PATH, demo: process.env.SEED_CHECKER_SESSIONS };
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-refusal-"));
    process.env.DATABASE_PATH = path.join(dir, "portal.db");
    process.env.PUBLIC_URL = HUB;
    delete process.env.DOGFOOD_SEED_SECRET;
  });
  afterEach(() => {
    for (const [key, value] of [["PUBLIC_URL", saved.url], ["DOGFOOD_SEED_SECRET", saved.secret], ["DATABASE_PATH", saved.db], ["SEED_CHECKER_SESSIONS", saved.demo]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  });

  it("refuses to start, saying why and what to set, before it opens or creates the database", async () => {
    await expect(boot()).rejects.toThrow(/refusing to start: PUBLIC_URL \(https:\/\/hack\.example\.org\) is not a local address.*set DOGFOOD_SEED_SECRET/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("with PUBLIC_URL unset and demo mode off, refuses too, before it opens the database", async () => {
    delete process.env.PUBLIC_URL;
    delete process.env.SEED_CHECKER_SESSIONS;
    await expect(boot()).rejects.toThrow(/refusing to start: DOGFOOD_SEED_SECRET is not set, so the public default and demo mode is off.*long random string/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
