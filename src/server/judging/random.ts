import "server-only";
import crypto from "node:crypto";

// Seeded randomness for assignment runs and review order. The seed is stored with
// each run, so a run can be replayed exactly: same seed and same input, same pairs.
// mulberry32 gives the same sequence on every platform for the same 32-bit seed.

export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
export function shuffle<T>(items: readonly T[], random: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function pick<T>(items: readonly T[], random: Rng): T {
  if (items.length === 0) throw new Error("pick() from an empty list");
  return items[Math.floor(random() * items.length)]!;
}

/** A fresh seed for a new run: a positive 31-bit integer, stored in the run's row. */
export function newSeed(): number {
  return crypto.randomInt(1, 2 ** 31 - 1);
}
