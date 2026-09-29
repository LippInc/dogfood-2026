// What the Judges page says after an invitation replaced an older one to the same address (an address holds one
// open invitation per event): the older link stopped working, so an organizer who mailed or pasted it knows.

const list = (to: string[]) => (to.length <= 5 ? to.slice(0, -1).join(", ") + (to.length > 1 ? " and " : "") + to.at(-1) : `${to.slice(0, 5).join(", ")} and ${to.length - 5} more`);

/** Null when nothing was replaced; otherwise one sentence naming the addresses whose older link stopped working. */
export function replacedNote(emails: string[]): string | null {
  if (!emails.length) return null;
  return emails.length === 1
    ? `The older invitation for ${emails[0]} stopped working: this new link replaces it.`
    : `The older invitations for ${list(emails)} stopped working: the new links replace them.`;
}
