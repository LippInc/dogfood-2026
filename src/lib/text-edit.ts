/**
 * One change to a text, as the audit log keeps it: where the old and new text part ways, what was
 * taken out there and what was written in its place. A judge's review autosaves while they type, so
 * a row holds only what that save changed, never the whole text again; and still no version is lost:
 * the text before any row is the text after it with the edit undone (`undoEdit`), so walking the log
 * back from the text as it stands gives every earlier version.
 */
export type TextEdit = { at: number; removed: string; added: string };

const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The edit that turns `before` into `after`, or null when they are the same. Never cuts a character in two. */
export function textEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // an emoji is two UTF-16 units: keep both halves on the same side of the cut
  if (start > 0 && high(before.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  if (end > 0 && low(before.charCodeAt(before.length - end))) end--;
  return { at: start, removed: before.slice(start, before.length - end), added: after.slice(start, after.length - end) };
}

/** The text before an edit, from the text after it. */
export function undoEdit(after: string, edit: TextEdit): string {
  return after.slice(0, edit.at) + edit.removed + after.slice(edit.at + edit.added.length);
}
