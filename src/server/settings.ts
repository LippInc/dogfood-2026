import "server-only";

// Operator settings that are whole numbers, read from the environment. Each has a safe
// default; boot refuses to start on a value that is not a whole number in range, so a typo
// never silently leaves the default in place. docs/OPERATIONS.md's settings table documents each one.

type Env = Record<string, string | undefined>;

export const OPERATOR_COUNTS = {
  /** sign-ups and password sign-ins together, per network address per 10 minutes */
  SIGN_IN_LIMIT_PER_ADDRESS: { fallback: 300, min: 1, max: 100_000 },
  /** how long a password sign-in lasts, in days, counted from the sign-in */
  SESSION_DAYS: { fallback: 14, min: 1, max: 366 },
} as const;

export type OperatorCount = keyof typeof OPERATOR_COUNTS;

function parseCount(raw: string | undefined, spec: { min: number; max: number }): number | null | "invalid" {
  const text = raw?.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return "invalid";
  const n = Number(text);
  return n >= spec.min && n <= spec.max ? n : "invalid";
}

/** The setting's value, or its default when unset (or invalid: boot has refused that already). */
export function operatorCount(name: OperatorCount, env: Env = process.env): number {
  const spec = OPERATOR_COUNTS[name];
  const n = parseCount(env[name], spec);
  return typeof n === "number" ? n : spec.fallback;
}

/**
 * Whether cookies are marked Secure (sent over HTTPS only). COOKIE_SECURE "true" or "false"
 * decides; unset, they are Secure when PUBLIC_URL starts with https://, so an HTTPS
 * deployment that forgets the variable still keeps its session cookies off plain http. The
 * offline run on http://localhost:8080 stays plain, which a browser needs to keep them there.
 */
export function secureCookies(env: Env = process.env): boolean {
  const flag = env.COOKIE_SECURE?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return /^https:\/\//i.test(env.PUBLIC_URL?.trim() ?? "");
}

/** Why the portal must not start, when a setting holds something that is not a whole number in range; else null. */
export function settingsProblem(env: Env = process.env): string | null {
  for (const [name, spec] of Object.entries(OPERATOR_COUNTS)) {
    if (parseCount(env[name], spec) === "invalid") {
      return `${name} must be a whole number from ${spec.min} to ${spec.max} (unset, it is ${spec.fallback}); it is "${env[name]}"`;
    }
  }
  return null;
}
