// What the portal keeps about people, for how long, and what removes it: one list, shown on the /privacy page and
// written out as the table under "What is kept, and for how long" in DATA-MODEL.md. tests/privacy-facts.test.ts
// fails when the two differ, so a change here goes into DATA-MODEL.md in the same commit (the test prints the table).
// tests/privacy-facts-schema.test.ts fails when a table holding a user id, an email or who-did-it is left out of it.
// A cell may hold `code` spans, as Markdown writes them.

export type KeptFact = { what: string; where: string; kept: string; removedBy: string };

export const KEPT: KeptFact[] = [
  {
    what: "A person's name, email address and password hash",
    where: "`users`",
    kept: "as long as the portal's data",
    removedBy: "nothing in the portal yet: removing the data volume",
  },
  {
    what: "Who organizes, judges or takes part in which event, and which tracks a judge covers",
    where: "`user_roles`, `judge_tracks`",
    kept: "as long as the portal's data, or until an organizer takes the person off the event",
    removedBy: "an organizer (removing a judge or an organizer); the audit log keeps the change",
  },
  {
    what: "Team membership: who is on which team, and who is its captain",
    where: "`team_members`",
    kept: "until the person leaves, is taken off the team, or the team is disbanded",
    removedBy: "the person, the team's captain, the organizers",
  },
  {
    what: "The name and email address a judge was invited with",
    where: "`judge_invites`",
    kept: "as long as the portal's data",
    removedBy: "removing the data volume",
  },
  {
    what: "Judging: the projects a judge was given, their scores per criterion, their feedback to the team, their private notes to the organizers and their pairwise answers",
    where: "`assignments`, `scores`, `score_items`, `score_comments`, `comparisons`",
    kept: "as long as the portal's data, and once the event's results are published the database refuses to change or delete them",
    removedBy: "nothing in the portal: a started review stays in the record (before publication the judge can change it; an organizer can withdraw only a review not yet started)",
  },
  {
    what: "Finals: who sat on a finals panel and their finals scores per criterion, and which organizer opened a finals round, added or took off a finalist, named the panel or closed it (with the reasons)",
    where: "`finals`, `finalists`, `finals_panel`, `finals_scores`, `finals_score_items`",
    kept: "as long as the portal's data, and once the event's results are published the database refuses to change or delete them",
    removedBy: "nothing in the portal: a panelist's saved score stays in the record (before publication the panelist can change it, and an organizer can take a finalist or a panelist off)",
  },
  {
    what: "Which organizer made an assignment run, a results run, a judge override (with its reason) or a webhook",
    where: "`assignment_runs`, `normalization_runs`, `judge_overrides`, `webhooks`",
    kept: "as long as the portal's data; results runs for good (append-only)",
    removedBy: "removing the data volume",
  },
  {
    what: "Email addresses on an organizer's voter list",
    where: "`voters.email`",
    kept: "as long as the portal's data",
    removedBy: "removing the data volume",
  },
  {
    what: "Comments, with the author's name beside them",
    where: "`comments`",
    kept: "until the author deletes it (not while the organizers have it hidden)",
    removedBy: "the author",
  },
  {
    what: "The organizers' updates to an event, with who posted each",
    where: "`event_updates`",
    kept: "until an organizer removes it (the audit log keeps its words)",
    removedBy: "the event's organizers",
  },
  {
    what: "Community-vote picks",
    where: "`votes`, `voters`",
    kept: "as long as the portal's data",
    removedBy: "the voter, while voting is open",
  },
  {
    what: "Keyed hashes of a voter's network address and browser",
    where: "`voters.ip_hash`, `voters.agent_hash`",
    kept: "until the operator purges them, once the vote has closed",
    removedBy: "`scripts/purge.mjs`",
  },
  {
    what: "Sign-in sessions (stored as a hash of the cookie)",
    where: "`sessions`",
    kept: "until sign-out or their end (`SESSION_DAYS`, default 14); an ended one is deleted within the hour",
    removedBy: "the portal, by itself",
  },
  {
    what: "A person's named API tokens (stored as a hash), with their first characters and when they were last used",
    where: "`api_tokens`",
    kept: "as long as the portal's data: a revoked or expired token stays as a row that no longer works",
    removedBy: "removing the data volume (the person can revoke one, which does not remove it)",
  },
  {
    what: "Password-reset and account-claim links (stored as a hash): for whom, who made them, when they were used",
    where: "`password_resets`, `account_claims`",
    kept: "as long as the portal's data: a used or expired link stays as a row; an unused one is replaced by the next",
    removedBy: "nothing in the portal (neither the hourly sweep nor `scripts/purge.mjs`): removing the data volume",
  },
  {
    what: "Keyed hashes of an email or network address, counting tries",
    where: "`rate_buckets`",
    kept: "about an hour after the last try (idle buckets are deleted every hour)",
    removedBy: "the portal, by itself",
  },
  {
    what: "Mail the portal sent: address, subject, body with its private link blanked (an update's public link and a judge reminder's console link, which needs the judge's sign-in, are kept; nothing while email is off)",
    where: "`outbox`",
    kept: "until the operator purges it (older than 90 days by default)",
    removedBy: "`scripts/purge.mjs`",
  },
  {
    what: "Changes sent to the organizers' webhooks, which can include names, and the receivers' answers",
    where: "`webhook_deliveries`",
    kept: "until the operator purges the finished ones (older than 90 days by default)",
    removedBy: "`scripts/purge.mjs`; the receiver keeps its own copy",
  },
  {
    what: "Signed certificates, with the person's name",
    where: "`signed_records`",
    kept: "for good: whoever holds one can check it; its page asks search engines not to index it",
    removedBy: "nothing",
  },
  {
    what: "Project pictures and gallery images, re-encoded without their metadata",
    where: "the uploads folder",
    kept: "until the team replaces or removes it, or the organizers take it down",
    removedBy: "the team, the organizers",
  },
  {
    what: "The audit log: who did what and when, by name, and email addresses in some entries (a judge invited, an organizer added or removed)",
    where: "`audit_log`",
    kept: "for good: it is append-only, and removing a row would break the chain",
    removedBy: "nothing",
  },
  {
    what: "Backups: a copy of all of the above",
    where: "`/data/backups`",
    kept: "the newest 7 (`BACKUP_KEEP`) on the volume, and any copied off it",
    removedBy: "the operator",
  },
];

/** The facts as DATA-MODEL.md's Markdown table. */
export function keptTableMarkdown(): string {
  return [
    "| What | Where | Kept | Removed by |",
    "|---|---|---|---|",
    ...KEPT.map((f) => `| ${f.what} | ${f.where} | ${f.kept} | ${f.removedBy} |`),
  ].join("\n");
}

/** A cell split into plain text and `code` spans (odd indexes are code). */
export function ticks(cell: string): string[] {
  return cell.split("`");
}
