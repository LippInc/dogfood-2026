const HERE = "http://portal.invalid";

/**
 * Where to go after signing in or up: only a path on this site. The value is read the way a
 * browser reads it (backslashes as slashes, tabs and newlines dropped), so "/\evil.example"
 * and "//evil.example" are another host and refused, as is "https://...".
 */
export function safeNext(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(value, HERE);
  } catch {
    return null;
  }
  return url.origin === HERE ? url.pathname + url.search + url.hash : null;
}
