/**
 * The Help panel's matcher: pure and synchronous, no dependency. A question is normalized (lower case, accents
 * dropped, a few phrases people type folded into one token, such as "plus minus" or "4 4 4"), split into words,
 * stripped of filler words and lightly stemmed; a word the guide never uses is read as the guide's word one typing
 * slip away, and each word also stands for its synonyms at a lower weight. Entries are scored with BM25 over three
 * fields (title, keywords, answer), each with its own weight and length normalization, and an entry whose whole
 * title the question names gets a bonus. An entry is a match only when it covers enough of what was asked, both
 * weighted by how rare each word is (COVERAGE_FLOOR) and counted word by word (at least 60 % of the question's words,
 * WORD_SHARE_FLOOR), and scores above MATCH_FLOOR. A word covers fully only when the entry's title or keywords name it
 * (or its typing slip); a hit through a synonym (SYNONYM_COVER) or only in the answer's text (ANSWER_COVER) covers
 * part of it: otherwise the answer is "no match", and the panel never guesses.
 * The stemmer never merges two different words ("tracking" is not "track"; KEEP_WHOLE).
 */

export type MatchDoc = { id: string; title: string; keywords: string[]; answer: string };

/** A best score below this is no match. */
export const MATCH_FLOOR = 0.8;
/** The share of the question (each word weighted by its rarity) an entry must cover to count as a match. */
export const COVERAGE_FLOOR = 0.35;
/** A second or third match must reach this share of the best one's score. */
export const RELATIVE_FLOOR = 0.45;
/** The share of the question's words (counted, not weighted; a synonym-only or answer-only hit counts for part of a
 *  word) an entry must cover, at least 60 %: one rare word no longer carries a question whose other words point
 *  elsewhere ("become" in "how do I become an organizer"). */
export const WORD_SHARE_FLOOR = 0.6;

const K1 = 1.2;
const FIELDS = { title: 3, keywords: 2, answer: 1 } as const;
type Field = keyof typeof FIELDS;
/** How much a field's length counts: a one-word title should not outweigh a precise three-word one. */
const B: Record<Field, number> = { title: 0.3, keywords: 0.6, answer: 0.6 };
const SYNONYM_WEIGHT = 0.6;
const TYPO_WEIGHT = 0.8;
/** How much a word the guide never uses counts against coverage: as much as a fairly rare word, not more. */
const UNKNOWN_WORD_WEIGHT = 2.5;
const TITLE_BONUS = 1.35;
/** How much of a question word a hit covers when it comes only through a synonym, or only from the answer's running
 *  text: part of it, so "judging" in a sign-out answer or "password" for "open link" never counts as a word answered. */
export const SYNONYM_COVER = 0.5;
export const ANSWER_COVER = 0.15;

// Words that say nothing about what is asked. "who", "where" and the like stay out of the index too.
const STOP = new Set(
  (
    "a an the is are am was were be been being do does did doing i me my mine we our us you your it its this that these those " +
    "how what where when why who whom which whose can could would should will shall may might must to of in on at by for from with " +
    "about into onto as and or but if so not no yes there here then than too very just also still ever please want need like " +
    "get got getting see seen look find show tell give go going use using used make made have has had some any all each " +
    "thing things way ways work works page portal dogfood hi hello thanks thank ok okay happen happens happened able possible " +
    "know mean means meaning explain question help else exactly actually really anything something someone anyone everything stuff " +
    "set up put many much per"
  ).split(" "),
);

// Phrases folded into one token before the words are split, on the lower-cased, accent-free text.
const PHRASES: [RegExp, string][] = [
  [/±|\+\s*\/\s*-|\+-|\bplus\s*(?:or\s*)?[-/]?\s*minus\b/g, " plusminus "],
  [/\b(\d)(?:\s*[/,\-\s]?\s*\1){2,}\b/g, " flatvector "],
  [/\b(?:log|sign)\s*-?\s*in\b|\blogin\b/g, " signin "],
  [/\b(?:log|sign)\s*-?\s*out\b|\blogout\b/g, " signout "],
  [/\bsign\s*-?\s*up\b|\bregister\b|\bcreate an account\b|\bnew account\b/g, " signup "],
  [/\bopen\s*-?\s*link\b/g, " openlink "],
  // "who can see my email": who sees one's own details, not the general word
  [/\bwho\s+(?:can\s+)?sees?\s+my\b/g, "$& whoseesmy "],
  // the team's name is not the person's own ("how do I change my name" is not a team rename)
  [/\bteam'?s?\s+name\b/g, " teamname "],
  // "my reviews", "my score": one's own outcome, not the idea of a review; the words stay too
  [/\b(?:my|our)\s+(?:own\s+)?(?:reviews?|feedback|scores?|place|results?|rank)\b/g, "$& myresult "],
  // "see the votes", "vote count", "live count": the count, not the ballot; the words stay too
  [/\b(?:see|view|watch|check)\s+(?:the\s+)?votes?\b|\bvotes?\s+count\b|\blive\s+count\b/g, "$& votecount "],
  [/\btoo\s+close\b/g, " tooclose "],
  [/\bpair\s*-?\s*wise\b/g, " pairwise "],
  [/\bco\s*-?\s*organi[sz]er/g, " coorganizer"],
  [/\be\s*-\s*mail/g, " email"],
  [/\bweb\s*-?\s*hook/g, " webhook"],
  [/\bhand\s*-?\s*in\b/g, " handin "],
  [/\bdark\s+mode\b|\blight\s+mode\b|\bnight\s+mode\b/g, " darkmode "],
  [/\bhead\s+hash\b|\bchain\s+head\b|\bhash\s+chain\b/g, " hashchain "],
];

/** Lower case, accents dropped (NFD), the phrases above folded. */
export function normalize(text: string): string {
  let t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t;
}

/**
 * Words the suffix rules would turn into a different word of the guide, kept whole (each form to one index word):
 * "tracking" (what the privacy page says there is none of) is not a "track", a "site" is not "sit", a "theme" is
 * not "them", the "standings" are not "stands", "rights" are not "right". tests/help.test.ts lists every group of
 * words the guide's own text merges, so a new one is seen.
 */
const KEEP_WHOLE: Record<string, string> = {
  tracking: "tracking",
  tracked: "tracking",
  site: "site",
  sites: "site",
  theme: "theme",
  themes: "theme",
  standings: "standings",
  rights: "rights",
};

/** A light suffix stemmer: plurals, -ing, -ed, -ation, a final e; applied to questions and entries alike. */
export function stem(word: string): string {
  let w = word;
  const whole = KEEP_WHOLE[w];
  if (whole) return whole;
  if (w.length <= 3) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (/(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w) && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ation") && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith("ment") && w.length > 7) w = w.slice(0, -4);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  // a doubled last consonant left by -ing or -ed (submitted, stopped) goes single
  if (/([bdgklmnprt])\1$/.test(w) && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** The index words of a text: normalized, split, filler dropped, stemmed. */
export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
    .filter((w) => w && !STOP.has(w));
}

/**
 * Words people type for the portal's own words, stemmed on both sides: each list is the words a question word also
 * stands for, at SYNONYM_WEIGHT. One-way, so a general word ("vote") does not pull every entry that says "ballot".
 */
const SYNONYM_SOURCE: [string, string[]][] = [
  ["plusminus", ["error", "margin", "uncertainty", "standard"]],
  ["error", ["plusminus", "margin"]],
  ["margin", ["plusminus", "error"]],
  ["uncertainty", ["plusminus", "error"]],
  ["confidence", ["plusminus", "error"]],
  ["lenient", ["leniency"]],
  ["generous", ["leniency"]],
  ["harsh", ["leniency"]],
  ["strict", ["leniency"]],
  ["bias", ["leniency"]],
  ["biased", ["leniency"]],
  ["tilt", ["leniency"]],
  ["normalise", ["normalization"]],
  ["normalize", ["normalization"]],
  ["correction", ["normalization", "leniency"]],
  ["corrected", ["normalization", "leniency"]],
  ["adjust", ["normalization", "leniency"]],
  ["adjusted", ["normalization", "leniency"]],
  ["votes", ["ballot"]],
  ["vote", ["ballot"]],
  ["voting", ["ballot"]],
  ["ballot", ["vote"]],
  ["favourite", ["vote", "ballot"]],
  ["favorite", ["vote", "ballot"]],
  ["pick", ["vote", "ballot"]],
  ["tally", ["count", "vote"]],
  ["winner", ["result", "rank", "place"]],
  ["winners", ["result", "rank", "place"]],
  ["won", ["result", "rank", "place"]],
  ["win", ["result", "rank", "place"]],
  ["ranking", ["place"]],
  ["ranked", ["place"]],
  ["leaderboard", ["result", "rank"]],
  ["standings", ["result", "rank"]],
  ["place", ["rank"]],
  ["score", ["review"]],
  ["scores", ["review"]],
  ["grade", ["score", "review"]],
  ["rate", ["score"]],
  ["rating", ["score"]],
  ["mark", ["score"]],
  ["marks", ["score"]],
  ["feedback", ["review"]],
  ["comments", ["comment"]],
  ["certificate", ["record"]],
  ["certificates", ["record"]],
  ["cert", ["certificate", "record"]],
  ["diploma", ["certificate", "record"]],
  ["badge", ["certificate", "record"]],
  ["signature", ["signed", "verify"]],
  ["check", ["verify"]],
  ["validate", ["verify"]],
  ["authentic", ["verify", "signed"]],
  ["fake", ["verify", "signed"]],
  ["genuine", ["verify", "signed"]],
  ["publish", ["result"]],
  ["release", ["publish", "result"]],
  ["announce", ["publish", "result"]],
  ["unpublish", ["publish", "freeze"]],
  ["frozen", ["freeze", "final"]],
  ["lock", ["freeze", "final"]],
  ["locked", ["freeze", "final", "decision"]],
  ["change", ["edit"]],
  ["edit", ["change"]],
  ["submit", ["handin", "project"]],
  ["submission", ["project", "handin"]],
  ["submissions", ["project"]],
  ["upload", ["picture", "image"]],
  ["entry", ["project"]],
  ["entries", ["project"]],
  ["hack", ["project"]],
  ["team", ["member"]],
  ["teammate", ["team", "member"]],
  ["join", ["team", "invite"]],
  ["invite", ["invitation", "link"]],
  ["invitation", ["invite", "link"]],
  ["add", ["invite"]],
  ["duplicate", ["merge", "twice"]],
  ["twice", ["duplicate", "merge"]],
  ["copy", ["duplicate"]],
  ["same", ["duplicate", "identical"]],
  ["identical", ["flat", "same"]],
  ["flat", ["identical"]],
  ["flatvector", ["flat", "identical"]],
  ["excluded", ["left", "out", "flat"]],
  ["exclude", ["left", "out"]],
  ["ignored", ["left", "out"]],
  ["removed", ["left", "out", "remove"]],
  ["history", ["audit", "log"]],
  ["trail", ["audit", "log"]],
  ["tamper", ["audit", "hashchain"]],
  ["tampering", ["audit", "hashchain"]],
  ["hash", ["hashchain", "audit"]],
  ["chain", ["hashchain", "audit"]],
  ["hashchain", ["hash", "chain", "audit"]],
  ["password", ["account", "signin"]],
  ["forgot", ["password", "reset"]],
  ["signin", ["account"]],
  ["signup", ["account"]],
  ["account", ["signin"]],
  ["demo", ["checker", "session"]],
  ["checker", ["demo", "session"]],
  ["cookie", ["session", "checker"]],
  ["cookies", ["session", "checker"]],
  ["token", ["api"]],
  ["tokens", ["api"]],
  ["key", ["api", "token"]],
  ["rest", ["api"]],
  ["json", ["api", "export"]],
  ["openapi", ["api"]],
  ["swagger", ["api"]],
  ["endpoint", ["api"]],
  ["endpoints", ["api"]],
  ["integration", ["webhook", "api"]],
  ["callback", ["webhook"]],
  ["notify", ["webhook", "email"]],
  ["notification", ["webhook", "email"]],
  ["mail", ["email"]],
  ["download", ["export", "csv"]],
  ["csv", ["export"]],
  ["excel", ["export", "csv"]],
  ["spreadsheet", ["export", "csv"]],
  ["backup", ["restore"]],
  ["restore", ["backup"]],
  ["save", ["backup", "draft"]],
  ["widget", ["embed"]],
  ["iframe", ["embed"]],
  ["website", ["embed"]],
  ["privacy", ["data", "keep"]],
  ["gdpr", ["privacy", "data"]],
  ["personal", ["privacy", "data"]],
  ["delete", ["remove", "privacy"]],
  ["erase", ["privacy", "remove"]],
  ["gallery", ["projects"]],
  ["browse", ["gallery", "projects"]],
  ["search", ["gallery"]],
  ["track", ["category"]],
  ["category", ["track"]],
  ["categories", ["track"]],
  ["rubric", ["criteria", "weight"]],
  ["criteria", ["rubric"]],
  ["criterion", ["rubric"]],
  ["weights", ["weight", "rubric"]],
  ["shortcut", ["keyboard", "key"]],
  ["shortcuts", ["keyboard", "key"]],
  ["hotkey", ["keyboard", "key"]],
  ["hotkeys", ["keyboard", "key"]],
  ["keys", ["keyboard", "key"]],
  ["compare", ["pairwise"]],
  ["comparison", ["pairwise"]],
  ["better", ["pairwise"]],
  ["versus", ["pairwise"]],
  ["vs", ["pairwise"]],
  ["conflict", ["recuse", "interest"]],
  ["recuse", ["conflict"]],
  ["friend", ["conflict", "recuse"]],
  ["random", ["signal", "chance"]],
  ["significant", ["signal"]],
  ["significance", ["signal"]],
  ["luck", ["signal", "chance"]],
  ["noise", ["signal"]],
  ["permutation", ["signal"]],
  ["assignment", ["assign"]],
  ["assigned", ["assign"]],
  ["assign", ["assignment"]],
  ["organiser", ["organizer"]],
  ["organisers", ["organizer"]],
  ["admin", ["administrator"]],
  ["administrator", ["admin"]],
  ["setting", ["settings"]],
  ["configure", ["settings"]],
  ["config", ["settings"]],
  ["options", ["settings"]],
  ["abuse", ["rate", "limit", "duplicate"]],
  ["spam", ["rate", "limit"]],
  ["429", ["rate", "limit"]],
  ["403", ["refusal"]],
  ["401", ["refusal"]],
  ["forbidden", ["refusal"]],
  ["denied", ["refusal"]],
  ["refused", ["refusal"]],
  ["event", ["events"]],
  ["hackathon", ["event"]],
  ["create", ["new"]],
  ["start", ["new"]],
  ["import", ["fixture"]],
  ["fixture", ["import"]],
  ["fixtures", ["import", "fixture"]],
  ["reset", ["password"]],
  ["deadline", ["date", "close"]],
  ["deadlines", ["date", "close"]],
  ["due", ["date", "close"]],
];

const SYNONYMS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [word, also] of SYNONYM_SOURCE) {
    const key = stem(normalize(word).trim());
    const list = map.get(key) ?? [];
    for (const a of also) {
      const s = stem(normalize(a).trim());
      if (s !== key && !list.includes(s)) list.push(s);
    }
    map.set(key, list);
  }
  return map;
})();

/** Whether two words are one typing slip apart: one letter added, dropped, changed, or two neighbours swapped. */
export function oneSlipApart(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diff: number[] = [];
    for (let i = 0; i < la && diff.length < 3; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

type IndexedDoc = { id: string; tf: Record<Field, Map<string, number>>; len: Record<Field, number>; title: Set<string> };

/** One word of the question: what it counts for coverage, and the index words that stand for it with their weights. */
type QueryWord = { weight: number; alts: Map<string, number> };

export type Scored = { id: string; score: number; coverage: number; wordShare: number };
export type Matcher = { size: number; words(question: string): QueryWord[]; score(question: string): Scored[] };

/**
 * Builds the BM25 index once. `score` ranks every entry that shares a word with the question, best first, with the
 * share of the question it covers; the caller applies the floors.
 */
export function buildMatcher(docs: MatchDoc[]): Matcher {
  const indexed: IndexedDoc[] = docs.map((d) => {
    // keywords are a set of phrases: a word counts once there, however many phrases repeat it
    const fieldText: Record<Field, string[]> = { title: tokens(d.title), keywords: [...new Set(tokens(d.keywords.join(" ")))], answer: tokens(d.answer) };
    const tf = { title: new Map(), keywords: new Map(), answer: new Map() } as Record<Field, Map<string, number>>;
    for (const f of Object.keys(FIELDS) as Field[]) for (const t of fieldText[f]) tf[f].set(t, (tf[f].get(t) ?? 0) + 1);
    return {
      id: d.id,
      tf,
      len: { title: fieldText.title.length, keywords: fieldText.keywords.length, answer: fieldText.answer.length },
      title: new Set(fieldText.title),
    };
  });
  const n = indexed.length;
  const avg = {} as Record<Field, number>;
  for (const f of Object.keys(FIELDS) as Field[]) avg[f] = Math.max(1, indexed.reduce((s, d) => s + d.len[f], 0) / Math.max(1, n));
  const df = new Map<string, number>();
  for (const d of indexed) {
    const seen = new Set<string>();
    for (const f of Object.keys(FIELDS) as Field[]) for (const t of d.tf[f].keys()) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // typing slips are read only as the guide's own titles and keywords, words of 5 letters or more
  const vocabulary = [...new Set(indexed.flatMap((d) => [...d.tf.title.keys(), ...d.tf.keywords.keys()]))].filter((v) => v.length >= 5);
  const idf = (t: string) => {
    const k = df.get(t) ?? 0;
    return Math.log(1 + (n - k + 0.5) / (k + 0.5));
  };

  /** The guide's word one slip away from an unknown word (the most used one, if several), for words of 5 letters or more. */
  const nearest = (w: string): string | null => {
    if (w.length < 5 || /^\d+$/.test(w)) return null;
    let best: string | null = null;
    for (const v of vocabulary) if (oneSlipApart(w, v) && (!best || df.get(v)! > df.get(best)!)) best = v;
    return best;
  };

  const words = (question: string): QueryWord[] => {
    const out: QueryWord[] = [];
    for (const w of [...new Set(tokens(question))]) {
      const known = df.has(w);
      const fix = known ? null : nearest(w);
      const base = fix ?? w;
      const alts = new Map<string, number>([[base, fix ? TYPO_WEIGHT : 1]]);
      for (const s of SYNONYMS.get(w) ?? SYNONYMS.get(base) ?? []) if (!alts.has(s)) alts.set(s, SYNONYM_WEIGHT);
      out.push({ weight: known || fix ? idf(base) : UNKNOWN_WORD_WEIGHT, alts });
    }
    return out;
  };

  return {
    size: n,
    words,
    score(question: string) {
      const qs = words(question);
      if (!qs.length) return [];
      const total = qs.reduce((s, q) => s + q.weight, 0);
      const named = new Set(qs.flatMap((q) => [...q.alts.entries()].filter(([, w]) => w >= TYPO_WEIGHT).map(([t]) => t)));
      const out: Scored[] = [];
      for (const d of indexed) {
        let score = 0;
        let covered = 0;
        let coveredWords = 0;
        for (const q of qs) {
          // how fully this entry answers the word: the word itself (or its typing slip) in the title or keywords
          // counts whole; only a synonym, or only the answer's running text, counts for part of it
          let hit = 0;
          for (const [t, weight] of q.alts) {
            let tf = 0;
            for (const f of Object.keys(FIELDS) as Field[]) {
              const c = d.tf[f].get(t);
              if (c) tf += (FIELDS[f] * c) / (1 - B[f] + (B[f] * d.len[f]) / avg[f]);
            }
            if (!tf) continue;
            const named = d.tf.title.has(t) || d.tf.keywords.has(t);
            hit = Math.max(hit, (weight >= TYPO_WEIGHT ? 1 : SYNONYM_COVER) * (named ? 1 : ANSWER_COVER));
            score += weight * idf(t) * ((tf * (K1 + 1)) / (tf + K1));
          }
          covered += q.weight * hit;
          coveredWords += hit;
        }
        if (score <= 0) continue;
        // a match through synonyms or the answer's running text scores for less than one that names the words
        const share = coveredWords / qs.length;
        score *= share * share;
        // the question is mostly the entry's whole title ("invite judges", "audit log", "pairwise mode")
        if (d.title.size && d.title.size * 2 >= qs.length && [...d.title].every((t) => named.has(t))) score *= TITLE_BONUS;
        out.push({ id: d.id, score, coverage: covered / total, wordShare: share });
      }
      return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    },
  };
}
