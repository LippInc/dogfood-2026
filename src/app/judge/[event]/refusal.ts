/** What a review holds that the judge types: the scores, the feedback and the private note. */
export type Draft = { values: Record<string, number | null>; feedback: string; privateNote: string };

/**
 * A refused save (401, 403, 409, 422) puts the review back to what the server last accepted, as the ballot does, so
 * the console never shows a score that was not saved; the status line says "Not saved" with the server's words. A
 * refusal that ends the judge's say over the review (401 signed out, 403 not theirs or judging closed, 409
 * session_changed: another tab signed in as someone else) also makes it read-only on this page.
 */
export function afterRefusal<R extends Draft & { readOnly: string | null }>(
  review: R,
  saved: Draft,
  status: number,
  body: { error?: unknown; message?: unknown },
): { review: R; message: string } {
  const said = typeof body.message === "string" && body.message ? body.message : null;
  const message = said ? (said.startsWith("Not saved") ? said : `Not saved: ${said}`) : "Not saved.";
  const final = status === 401 || status === 403 || body.error === "session_changed";
  return {
    review: {
      ...review,
      values: { ...saved.values },
      feedback: saved.feedback,
      privateNote: saved.privateNote,
      readOnly: final ? (said ?? "You can no longer change this review.") : review.readOnly,
    },
    message,
  };
}
