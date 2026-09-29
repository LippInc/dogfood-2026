// LinkedIn's "Add to profile" link for a certification: a plain link the person opens in their own
// browser, so the portal fetches nothing (it stays offline-safe). Parameter names from LinkedIn's
// Add to Profile builder (addtoprofile.linkedin.com): startTask=CERTIFICATION_NAME, name,
// organizationName (organizationId only for a company page, never both), issueYear, issueMonth,
// certUrl, certId. LinkedIn may leave fields it no longer pre-fills blank; the link still opens
// the add-certification form.

export type LinkedInCert = {
  /** The certification's name as it should read on the profile. */
  name: string;
  /** Who issued it: the event. */
  organization: string;
  /** ISO timestamp of issue; read in UTC, like every date the portal shows. */
  issuedAt: string;
  /** The record's public address, where anyone can check it. */
  url: string;
  /** The record's id. */
  id: string;
};

export function linkedInAddHref(c: LinkedInCert): string {
  const d = new Date(c.issuedAt);
  const q = new URLSearchParams({ startTask: "CERTIFICATION_NAME", name: c.name, organizationName: c.organization });
  if (!Number.isNaN(d.getTime())) {
    q.set("issueYear", String(d.getUTCFullYear()));
    q.set("issueMonth", String(d.getUTCMonth() + 1));
  }
  q.set("certUrl", c.url);
  q.set("certId", c.id);
  return `https://www.linkedin.com/profile/add?${q.toString()}`;
}

/** The name a record goes by on a profile: the award when it has one, else the part the person played. */
export function linkedInCertName(r: { kind: "judge" | "participant"; awards?: string[]; projectTitle?: string }): string {
  if (r.kind === "judge") return "Judge";
  const lead = r.awards?.[0] ?? "Participant";
  return r.projectTitle ? `${lead}: ${r.projectTitle}` : lead;
}
