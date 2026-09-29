// The one canonical JSON of the portal, the bytes every audit-row hash and every record signature covers: JSON with
// no whitespace, arrays in order, and each object's keys sorted (JavaScript's default sort, by UTF-16 code unit), then
// written in the order JavaScript gives an object built in that order. That order puts the keys that are array
// indices (a whole number from 0 to 4294967294 written plainly: "2", "10", not "02" or "-1") first, by number, and the
// rest after them in sorted order: {"10":1,"2":2,"a":3} is written {"2":2,"10":1,"a":3}. The records the portal signs
// have no such keys; an audit row's before and after can (a criterion or question named "10"). Changing the order now
// would change the hash of every row that has them, so it stays, stated here and in DATA-MODEL.md ("The chain").
// The server uses it through src/server/util.ts and the record page's signature check in the browser imports it
// (src/app/records/[record]/check.tsx). scripts/verify-record.mjs, which runs on Node's built-ins alone, keeps a copy
// written the same way; tests/canonical-json.test.ts feeds the same records through both and demands the same bytes.

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
