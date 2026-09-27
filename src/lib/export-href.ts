// Where the organizer's download links point. A CSV opened by double-click in Excel is
// read as the local code page unless it starts with a UTF-8 byte-order mark, which turns
// "José" into "JosÃ©"; scripts usually want no mark. So the API adds one only when asked
// (?bom=1), and the portal's own download buttons ask.
export function exportHref(eventId: string, file: string): string {
  return `/api/events/${eventId}/export/${file}${file.endsWith(".csv") ? "?bom=1" : ""}`;
}
