// What the portal keeps about people, for how long, and what removes it: one list, shown on the /privacy page and
// written out as the table under "What is kept, and for how long" in DATA-MODEL.md. tests/privacy-facts.test.ts
// fails when the two differ, so a change here goes into DATA-MODEL.md in the same commit (the test prints the table).
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
    what: "The name and email address a judge was invited with",
    where: "`judge_invites`",
    kept: "as long as the portal's data",
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
    what: "Keyed hashes of an email or network address, counting tries",
    where: "`rate_buckets`",
    kept: "about an hour after the last try (idle buckets are deleted every hour)",
    removedBy: "the portal, by itself",
  },
  {
    what: "Mail the portal sent: address, subject, body with its link blanked (nothing while email is off)",
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
    kept: "for good: whoever holds one can check it",
    removedBy: "nothing",
  },
  {
    what: "Project pictures, re-encoded without their metadata",
    where: "the uploads folder",
    kept: "until the team replaces it or the organizers take it down",
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
