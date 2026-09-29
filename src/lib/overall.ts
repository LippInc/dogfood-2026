import { publishedPlaces } from "@/lib/places";

/**
 * The public overall order: every ranked project of the event in one list, by the published run's
 * rankOverall (its place by score across every track, equal scores sharing an average rank), for
 * reading across tracks. Places and prizes stay decided within each track: each entry carries its
 * track place exactly as the per-track results page counts it (publishedPlaces over the track's
 * rows, in their published order: the tie-break and the finals included), so the two pages never
 * disagree about a place.
 */

type Track<R> = { id: string; name: string; rows: R[] };
type Ranked = { score: number | null; rankOverall: number | null; tie?: number | null; finals?: { score: number | null } | null };

export type OverallEntry<R> = {
  row: R;
  track: { id: string; name: string; index: number };
  /** the place in its track, as the per-track results page shows it; `finals` when a finals panel decided it (the row is a finalist) */
  trackPlace: { place: number; joint: boolean; finals: boolean };
  /** the place in this one list, competition style: equal rankOverall values share the first place of their group */
  position: number;
  joint: boolean;
};

export function overallOrder<R extends Ranked>(tracks: Track<R>[]): OverallEntry<R>[] {
  const entries: (Omit<OverallEntry<R>, "position" | "joint"> & { at: number })[] = [];
  tracks.forEach((t, index) => {
    const places = publishedPlaces(t.rows);
    t.rows.forEach((row, i) => {
      const place = places[i]!;
      // a project with no place in its track (no score) has none here either
      if (place.place === null || row.rankOverall === null) return;
      entries.push({ row, track: { id: t.id, name: t.name, index }, trackPlace: { place: place.place, joint: place.joint, finals: Boolean(row.finals) }, at: entries.length });
    });
  });
  entries.sort((a, b) => a.row.rankOverall! - b.row.rankOverall! || a.at - b.at);
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  return entries.map((e) => {
    const mine = e.row.rankOverall!;
    const ahead = entries.filter((x) => x.row.rankOverall! < mine && !same(x.row.rankOverall!, mine)).length;
    const joint = entries.filter((x) => same(x.row.rankOverall!, mine)).length > 1;
    return { row: e.row, track: e.track, trackPlace: e.trackPlace, position: ahead + 1, joint };
  });
}
