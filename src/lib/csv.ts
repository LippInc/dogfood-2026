// RFC 4180 CSV, shared by the server's exports and the files the browser builds
// (the personal-links download), so every CSV the portal hands out quotes the
// same way. A text cell that a spreadsheet would read as a formula (starting
// with = + - @ tab or carriage return) gets a leading apostrophe, so an export
// opened in Excel cannot run what a participant, judge or voter typed into a
// title or a name. A value that starts with an apostrophe of its own gets one
// too, so a reader can always drop one leading apostrophe to get the value back
// (the audit.csv recipe relies on it).

export type Cell = string | number | boolean | null | undefined;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = /^[=+\-@\t\r']/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// The personal-links file an organizer downloads right after making claim links:
// one row per person, the link made absolute against the portal's own origin.
export function personalLinksCsv(links: { name: string; email: string; path: string }[], origin: string): string {
  return toCsv(["name", "email", "link"], links.map((l) => [l.name, l.email, origin + l.path]));
}
