import { describe, expect, it } from "vitest";
import { mailNote } from "@/lib/mail-note";

// The note a screen shows after mailing links: each failure with its own reason, and a message whose
// outcome is unknown said apart from one that was not sent.

describe("mailNote", () => {
  it("says nothing with email off or nobody to mail, and names a single success", () => {
    expect(mailNote({ on: false, mailed: [] })).toBeNull();
    expect(mailNote({ on: true, mailed: [] })).toBeNull();
    expect(mailNote({ on: true, mailed: [{ to: "a@x.test", status: "sent" }] })).toBe("Mailed to a@x.test.");
    expect(mailNote({ on: true, mailed: [{ to: "a@x.test", status: "sent" }, { to: "b@x.test", status: "sent" }] })).toBe("Mailed to all 2.");
  });

  it("a mixed batch explains each failure with its own reason, not the first one's", () => {
    const note = mailNote({
      on: true,
      mailed: [
        { to: "ok@x.test", status: "sent" },
        { to: "bad@x.test", status: "failed", error: "550 no such mailbox" },
        { to: "late1@x.test", status: "failed", error: "not tried: the batch ran out of time" },
        { to: "late2@x.test", status: "failed", error: "not tried: the batch ran out of time" },
      ],
    })!;
    expect(note).toBe("Mailed 1 of 4. Could not mail bad@x.test (550 no such mailbox); late1@x.test, late2@x.test (not tried: the batch ran out of time).");
  });

  it("one reason for all failures is said once", () => {
    const note = mailNote({ on: true, mailed: [1, 2, 3].map((i) => ({ to: `p${i}@x.test`, status: "failed" as const, error: "connect ECONNREFUSED" })) });
    expect(note).toBe("Could not mail any of the 3 (connect ECONNREFUSED).");
  });

  it("an unknown outcome is not called a failure, and the advice warns that a new link replaces the old one", () => {
    const one = mailNote({ on: true, mailed: [{ to: "a@x.test", status: "unknown", error: "Timeout" }] })!;
    expect(one).toMatch(/^It may have arrived/);
    expect(one).toMatch(/Ask before making a new link/);
    expect(one).not.toMatch(/Could not mail/);
    const mixed = mailNote({ on: true, mailed: [{ to: "a@x.test", status: "sent" }, { to: "b@x.test", status: "unknown", error: "Timeout" }] })!;
    expect(mixed).toMatch(/^Mailed 1 of 2\. b@x\.test may have arrived/);
  });
});
