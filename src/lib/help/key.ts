/**
 * Whether a key press should open Help: "?" alone, not while typing, not over another dialog, not when a page
 * handles its own "?" (the judge console and the compare page mark their root with data-question-key and keep
 * their key sheets on it), not when something handled the key already, and not when the reader turned the key off
 * (WCAG 2.1.4: a single-character shortcut can be switched off).
 */
export type KeyLike = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  repeat: boolean;
  target: unknown;
};
export type PageLike = { querySelector(selector: string): unknown };

/** The selector a page puts on its root to keep "?" for itself. */
export const OWN_QUESTION_KEY = "[data-question-key]";
const TEXT_FIELD = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const OPEN_DIALOG = "[role='dialog'], [role='alertdialog']";

export function helpKeyWanted(e: KeyLike, page: PageLike, keyOn: boolean): boolean {
  if (!keyOn || e.key !== "?" || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented || e.repeat) return false;
  const target = e.target as { closest?: (s: string) => unknown } | null;
  if (target && typeof target.closest === "function" && target.closest(TEXT_FIELD)) return false;
  if (page.querySelector(OWN_QUESTION_KEY)) return false;
  if (page.querySelector(OPEN_DIALOG)) return false;
  return true;
}

/** The reader's choice for the "?" key, kept in this browser only (a convenience; it defaults to on). */
export const HELP_KEY_STORAGE = "help-key";
