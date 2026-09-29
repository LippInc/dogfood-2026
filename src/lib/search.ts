// The gallery's search, one definition for the browser and the API: every word typed must appear in a project's
// title, summary, write-up ("What you built"), team, track, id or tags, ignoring case and accents ("ecole" finds
// "École", "muller" finds "Müller"). The tag filter keeps the projects that carry one tag, case and accents ignored.

/** Case and diacritics folded away: NFD splits "é" into "e" and a combining mark, and the marks are dropped. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The words of a search, folded. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/**
 * A long text as the search needs it: its folded words, each once. A search word holds no space, so it occurs in
 * the text exactly when it occurs inside one of the text's words: this finds the same projects as the whole text
 * while the gallery page carries a fraction of it (a write-up may run to 20,000 characters).
 */
export function searchText(text: string): string {
  return [...new Set(fold(text).split(/\s+/).filter(Boolean))].join(" ");
}

export type Searchable = {
  id: string;
  title: string;
  teamName: string;
  trackName: string;
  tags: string[];
  summary?: string;
  /** the write-up as searchText gives it; empty while the organizer hides the field */
  text?: string;
};

/** What the gallery shows of a project, folded: every field the search reads except the write-up. */
export const shownHay = (p: Searchable) => fold(`${p.title} ${p.summary ?? ""} ${p.teamName} ${p.trackName} ${p.id} ${p.tags.join(" ")}`);

/** Whether every word appears somewhere in the project's searchable fields. No words: everything matches. */
export function projectMatches(p: Searchable, words: string[]): boolean {
  if (!words.length) return true;
  const hay = `${shownHay(p)} ${p.text ?? ""}`;
  return words.every((w) => hay.includes(w));
}

/** A tag as the filter compares it: "Rust", "rust" and " RUST " are one tag. */
export const tagKey = (tag: string) => fold(tag.trim());

/** Whether a project carries the tag. No tag: every project does. */
export function hasTag(p: Pick<Searchable, "tags">, tag: string | null | undefined): boolean {
  if (!tag) return true;
  const key = tagKey(tag);
  return p.tags.some((t) => tagKey(t) === key);
}

/**
 * The tags the projects carry, each once (under its most used spelling), with how many projects carry it: the most
 * carried first, then by name.
 */
export function tagCounts(list: Pick<Searchable, "tags">[]): { key: string; label: string; count: number }[] {
  const by = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const p of list) {
    const seen = new Set<string>();
    for (const t of p.tags.map((x) => x.trim()).filter(Boolean)) {
      const key = tagKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      const e = by.get(key) ?? { count: 0, spellings: new Map() };
      if (!by.has(key)) by.set(key, e);
      e.count++;
      e.spellings.set(t, (e.spellings.get(t) ?? 0) + 1);
    }
  }
  return [...by.entries()]
    .map(([key, e]) => ({ key, count: e.count, label: [...e.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
