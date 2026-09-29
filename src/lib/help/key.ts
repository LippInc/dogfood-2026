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

type Box = { getClientRects(): { length: number } };
export type TriggerLike = Box & { closest(selector: string): { querySelector(selector: string): Box | null } | null };

/**
 * Whether this Help button takes the "?" key: the one on screen, so exactly one opens and Escape gives focus back to
 * something the reader can see. The bar's Help is hidden below md (display: none, no boxes); there the phone menu's
 * Help row takes the key, as long as its Menu button is on screen (the menu itself may be closed), and focus returns
 * to that Menu button.
 */
export function ownsHelpKey(variant: "public" | "work" | "menu", trigger: TriggerLike | null): boolean {
  if (!trigger) return false;
  if (variant !== "menu") return trigger.getClientRects().length > 0;
  const summary = trigger.closest("details")?.querySelector("summary");
  return Boolean(summary && summary.getClientRects().length > 0);
}

/** The reader's choice for the "?" key, kept in this browser only (a convenience; it defaults to on). */
export const HELP_KEY_STORAGE = "help-key";
