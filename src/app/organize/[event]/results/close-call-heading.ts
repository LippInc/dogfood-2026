import { plural } from "@/lib/format";

/**
 * The Results page's "Close calls" heading. It counts only the tracks too close to call now: a track the scores now
 * decide that still carries a kept or decided choice is listed below as an earlier choice, never counted as close.
 */
export function closeCallsHeading(calls: readonly { callable: boolean }[]): string {
  const now = calls.filter((c) => !c.callable).length;
  return now ? `Close calls: ${plural(now, "track")} too close to call from the scores` : "Close calls: no track too close to call from the scores now";
}
