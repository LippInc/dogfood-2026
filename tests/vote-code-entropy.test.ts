import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newSecret } from "@/server/util";

// THREAT-MODEL.md says how hard a vote code is to guess. The codes are drawn from 18 or 24 random bytes
// (144 or 192 bits), but newSecret writes "-" and "_" as "x", so three of base64url's 64 symbols read as
// one: the entropy per character is 61/64 * 6 + 3/64 * log2(64/3), about 5.926 bits, not 6. The doc gives
// both figures, the drawn bits and the entropy, computed here.

const perChar = (61 / 64) * 6 + (3 / 64) * Math.log2(64 / 3);

describe("the vote codes' strength, as THREAT-MODEL.md states it", () => {
  it("codes are 24 and 32 letters or digits drawn from 144 and 192 bits, about 142 and 190 bits of entropy", () => {
    const open = newSecret(18);
    const listed = newSecret(24);
    expect([open.length, listed.length]).toEqual([24, 32]);
    // the fold exists: no "-" or "_" ever appears, across many codes
    const many = Array.from({ length: 400 }, () => newSecret(24)).join("");
    expect(many).toMatch(/^[A-Za-z0-9]+$/);
    const low = Math.round(24 * perChar);
    const high = Math.round(32 * perChar);
    expect([low, high]).toEqual([142, 190]);
    // known-bad control: without the fold (6 bits a character) the figures would be the drawn bits
    expect([24 * 6, 32 * 6]).toEqual([144, 192]);
    const doc = fs.readFileSync(path.join(process.cwd(), "THREAT-MODEL.md"), "utf8");
    expect(doc).toContain(`drawn from 144 to 192 random bits (about ${low} to ${high} bits of entropy`);
    expect(doc).not.toContain("each code is 144 to 192 random bits");
  });
});
