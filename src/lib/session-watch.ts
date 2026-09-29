/**
 * One browser keeps one sign-in: every tab of it sends the same session cookie. So when someone signs in as another
 * person (or signs out) in tab B, tab A still shows the page it drew for the person before, and whatever it saves
 * next goes out as the new person. Each page knows whom it was drawn for; this module tells it when that stops
 * being true, and hands its saves the header that lets the server refuse one sent for the wrong person.
 *
 * - A page that mounts announces its person on a BroadcastChannel; every other tab compares that with its own.
 * - A tab that comes back into view (focus, visibilitychange) asks GET /api/auth/session who the session is now,
 *   which also catches an ending no tab announced: a session that expired, or one a password reset ended.
 */

/** Whom a page was drawn for, or null for a visitor. */
export type PagePerson = { id: string; name: string } | null;

/** What a tab learns: nothing changed, the person changed, or the browser is now signed out. */
export type Staleness = { kind: "same" } | { kind: "changed"; to: string } | { kind: "signed-out" };

export const SESSION_CHANNEL = "dogfood-session";

/** The header a page's saves carry: the id of the person the page was drawn for. */
export const PERSON_HEADER = "x-dogfood-person";

/** Compare the person a page was drawn for with the person the browser's session is now. */
export function staleness(page: PagePerson, now: PagePerson): Staleness {
  if ((page?.id ?? null) === (now?.id ?? null)) return { kind: "same" };
  if (!now) return { kind: "signed-out" };
  return { kind: "changed", to: now.name };
}

/** A message on the channel: a tab now shows this person. Anything else is ignored. */
export function readAnnouncement(data: unknown): PagePerson | undefined {
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== "person") return undefined;
  const p = (data as { person?: unknown }).person;
  if (p === null) return null;
  if (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string" && typeof (p as { name?: unknown }).name === "string") {
    return { id: (p as { id: string }).id, name: (p as { name: string }).name };
  }
  return undefined;
}

// The page's person, for the saves' header. Set by <SessionWatch> as the page mounts; undefined before that (and in
// tests), when saves carry no header and the server checks nothing extra.
let pagePerson: PagePerson | undefined;
// Set once this tab has learned that the browser's session belongs to someone else (or no one).
let stale = false;

export function setPagePerson(person: PagePerson): void {
  pagePerson = person;
  stale = false;
}

export function markStale(): void {
  stale = true;
}

/** True once this tab knows its saves would go out as someone other than the page's person. */
export function pageIsStale(): boolean {
  return stale;
}

/** Headers for a save from this page: the page's person, so the server can answer 409 session_changed. */
export function personHeaders(): Record<string, string> {
  return pagePerson ? { [PERSON_HEADER]: pagePerson.id } : {};
}
