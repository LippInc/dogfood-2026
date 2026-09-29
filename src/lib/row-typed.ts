/**
 * Whether a row of the rows editor is worth sending: a stored row always is; a new row only once
 * someone changed a field from the blank row's value, whatever the field's kind (a text typed in,
 * a number, a choice or a tick changed). A blank row nobody touched is left out, so the empty row
 * the editor starts with never fails validation; a row with only a weight or a tick changed is
 * sent, so the server's refusal names it instead of the change silently vanishing.
 */
export function rowTyped(
  row: Record<string, unknown>,
  fields: { key: string; type: "text" | "number" | "select" | "checkbox" }[],
  blank: Record<string, unknown>,
): boolean {
  if (row.id !== undefined) return true;
  return fields.some((f) => {
    if (f.type === "checkbox") return Boolean(row[f.key]) !== Boolean(blank[f.key]);
    const now = String(row[f.key] ?? "").trim();
    return f.type === "text" ? now !== "" : now !== String(blank[f.key] ?? "").trim();
  });
}
