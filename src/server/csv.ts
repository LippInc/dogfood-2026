import "server-only";

// RFC 4180 CSV. A text cell that a spreadsheet would read as a formula (starting
// with = + - @ tab or carriage return) gets a leading apostrophe, so an export
// opened in Excel cannot run what a participant typed into a title. A value that
// starts with an apostrophe of its own gets one too, so a reader can always drop
// one leading apostrophe to get the value back (the audit.csv recipe relies on it).

export type Cell = string | number | boolean | null | undefined;

function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = /^[=+\-@\t\r']/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
