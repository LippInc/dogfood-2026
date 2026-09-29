import { describe, expect, it } from "vitest";
import { commentStatusShows } from "@/lib/comment-status";

// A persona posted a comment, deleted it, and "Posted." stayed beside "Post comment" for a
// comment that no longer existed. The line now lives only as long as the comment it announced.

describe("the comment box's Posted. line", () => {
  const posted = { ok: true, message: "Posted.", commentId: "cmt_1" };

  it("goes once the author deletes the comment it announced", () => {
    expect(commentStatusShows(posted, ["cmt_0"])).toBe(false);
    expect(commentStatusShows(posted, [])).toBe(false);
  });

  it("positive controls: it shows while the comment is listed, and a refusal always shows", () => {
    expect(commentStatusShows(posted, ["cmt_0", "cmt_1"])).toBe(true);
    expect(commentStatusShows({ ok: false, message: "Comments open once a project is submitted." }, [])).toBe(true);
    expect(commentStatusShows({ ok: false, message: null }, [])).toBe(false);
  });
});
