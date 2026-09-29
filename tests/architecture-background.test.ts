import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ARCHITECTURE.md said "The only background work is the webhook worker" after boot.ts began starting the retention
// sweep too, and its scripts bullet left out purge.mjs. These checks read the code for what it starts and ships.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const arch = read("ARCHITECTURE.md");
const section = (doc: string, heading: string) => {
  const at = doc.indexOf(heading);
  if (at < 0) return "";
  const next = doc.indexOf("\n## ", at + heading.length);
  return doc.slice(at, next < 0 ? undefined : next);
};

/** The timers boot.ts starts: every `startSomething();` call on its own line, the Worker/Sweeper kind. */
function startedAtBoot(): string[] {
  return [...read("src/server/boot.ts").matchAll(/^\s*(start[A-Z]\w*(?:Worker|Sweeper))\(\);/gm)].map((m) => m[1]!);
}

const missingStarters = (doc: string) => startedAtBoot().filter((f) => !section(doc, "## Background work").includes(`\`${f}()\``));
const missingScripts = (doc: string) =>
  fs.readdirSync(path.join(process.cwd(), "scripts")).filter((f) => f.endsWith(".mjs") && !doc.includes(f));

describe("ARCHITECTURE.md names all the background work and every operator script", () => {
  it("finds what boot.ts starts (the scan itself works)", () => {
    expect(startedAtBoot()).toEqual(expect.arrayContaining(["startWebhookWorker", "startRetentionSweeper"]));
  });

  it("the Background work section names each timer boot.ts starts, and says it keeps rate-limit keys hashed", () => {
    expect(missingStarters(arch)).toEqual([]);
    expect(section(arch, "## Background work")).not.toMatch(/The only background work is the webhook worker/);
    expect(section(arch, "## Background work")).toMatch(/DOGFOOD_SEED_SECRET/);
  });

  it("every script in scripts/ is named", () => {
    expect(missingScripts(arch)).toEqual([]);
  });

  it("known-bad: a document without them is caught", () => {
    expect(missingStarters("## Background work\n\n`startWebhookWorker()` only.")).toEqual(["startRetentionSweeper"]);
    expect(missingScripts("backup.mjs restore.mjs")).toContain("purge.mjs");
  });
});
