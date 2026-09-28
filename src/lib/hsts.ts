// Strict-Transport-Security: only when the portal says it lives on https (PUBLIC_URL), since a browser that
// once saw it refuses plain http to that host for the whole max-age, and the offline run is http://localhost.
// Without includeSubDomains: the operator's other hosts are not the portal's to decide.

export const HSTS_VALUE = "max-age=31536000";

export function hstsFor(publicUrl: string | undefined): string | null {
  return /^https:\/\//i.test(publicUrl?.trim() ?? "") ? HSTS_VALUE : null;
}
