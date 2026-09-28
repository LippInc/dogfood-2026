import { formatUtc } from "./format";

/** A published track move in words: "Moved by the organizers from Security to Climate on 28 Sep 2026, 21:40 UTC". */
export function trackMoveWords(m: { fromTrack: string; toTrack: string; at: string }): string {
  return `Moved by the organizers from ${m.fromTrack} to ${m.toTrack} on ${formatUtc(m.at)}`;
}
