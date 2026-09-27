import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/session";

const original = crypto.argon2Sync;

afterEach(() => {
  crypto.argon2Sync = original;
});

describe("passwords on a Node without argon2", () => {
  it("hashes and verifies on this Node (positive control)", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("known-bad runtime: without crypto.argon2Sync the error names the Node version to use", () => {
    // @ts-expect-error simulating an older Node that has no argon2Sync
    crypto.argon2Sync = undefined;
    expect(() => hashPassword("x")).toThrow(/use a current Node 24/);
  });
});
