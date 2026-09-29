// The gallery's search, one definition for the browser and the API: every word typed must appear in a project's
// title, team, track, id or tags, ignoring case and accents ("ecole" finds "École", "muller" finds "Müller").

/** Case and diacritics folded away: NFD splits "é" into "e" and a combining mark, and the marks are dropped. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The words of a search, folded. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

export type Searchable = { id: string; title: string; teamName: string; trackName: string; tags: string[] };

/** Whether every word appears somewhere in the project's searchable fields. No words: everything matches. */
export function projectMatches(p: Searchable, words: string[]): boolean {
  if (!words.length) return true;
  const hay = fold(`${p.title} ${p.teamName} ${p.trackName} ${p.id} ${p.tags.join(" ")}`);
  return words.every((w) => hay.includes(w));
}

/**
 * Where folded words occur in the original text, as [start, end) ranges of it, so a highlight lands on "École" for
 * "ecole" even though folding changes the text's length.
 */
export function matchRanges(text: string, words: string[]): [number, number][] {
  let folded = "";
  const from: number[] = []; // for each folded character, where its source starts in text
  const to: number[] = []; // ...and where it ends
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    if (!f && to.length) to[to.length - 1] = i + ch.length; // a lone combining mark belongs to the letter before it
    for (const c of f) {
      folded += c;
      from.push(i);
      to.push(i + ch.length);
    }
    i += ch.length;
  }
  const ranges: [number, number][] = [];
  for (const w of words) {
    for (let at = folded.indexOf(w); at !== -1 && w; at = folded.indexOf(w, at + 1)) ranges.push([from[at]!, to[at + w.length - 1]!]);
  }
  return ranges;
}
