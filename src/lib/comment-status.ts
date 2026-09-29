/**
 * Whether the comment box's result line still belongs beside "Post comment". "Posted." speaks for
 * one comment: once its author deletes that comment the line goes with it. A refusal stays until
 * the next try, and a result with no comment id (an older form) shows as before.
 */
export function commentStatusShows(state: { ok: boolean; message: string | null; commentId?: string }, listed: readonly string[]): boolean {
  if (!state.message) return false;
  if (!state.ok || !state.commentId) return true;
  return listed.includes(state.commentId);
}
