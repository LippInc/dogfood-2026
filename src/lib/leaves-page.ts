/**
 * Whether a click on a link takes this tab to another page, so a page holding unsaved work
 * should ask first. A click that opens a new tab or window (a modifier key, a middle click,
 * target="_blank"), downloads a file, was already handled by someone else, or only moves to
 * a place on the same page, or points at the page itself, leaves the page where it is. A link
 * to another site is left to the browser's own leave question (beforeunload), which a full
 * page load always asks.
 */
export type LinkClick = {
  href: string | null;
  target: string | null;
  download: boolean;
  button: number;
  modified: boolean;
  defaultPrevented: boolean;
};

export function leavesPage(click: LinkClick, current: string): boolean {
  if (click.defaultPrevented || click.button !== 0 || click.modified || click.download) return false;
  if (click.target && click.target.toLowerCase() !== "_self") return false;
  if (!click.href) return false;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(click.href, from);
  } catch {
    return false;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return false; // mailto:, javascript:, ...
  if (to.origin !== from.origin) return false;
  // the same path and query: a #fragment move or a link to the page itself (the shell's section link for the page
  // you are on, also after the skip link added #main); the page stays either way
  if (to.pathname === from.pathname && to.search === from.search) return false;
  return true;
}
