import "server-only";
import { createHash } from "node:crypto";

// Project faces: a 1-bit picture made from a project's id, so a project without
// images still has a face, and the same face follows it from the gallery to the
// judge console. SHA-256 of the id picks one of four motifs and its geometry; a
// 4x4 Bayer matrix dithers the motif's intensity into cells; the cells become one
// SVG path. Fills come from CSS variables (--face-bg, --face-dot), so a mode switch
// repaints every face without regenerating anything.

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// Geometry lives in a 16 x 9 unit box, so every grid size draws the same shape.
const UW = 16;
const UH = 9;

type Field = (ux: number, uy: number) => number;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function byteStream(id: string): () => number {
  let block = createHash("sha256").update(`face:${id}`).digest();
  let i = 0;
  let round = 0;
  return () => {
    if (i >= block.length) {
      round += 1;
      block = createHash("sha256").update(`face:${id}:${round}`).digest();
      i = 0;
    }
    return block[i++] / 255;
  };
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

function blobs(r: () => number): Field {
  const count = r() < 0.55 ? 1 : 2;
  const spots = Array.from({ length: count }, () => ({
    cx: between(r, 3, 13),
    cy: between(r, 2.2, 6.8),
    rad: between(r, count === 1 ? 3.2 : 1.8, count === 1 ? 5 : 3.2),
  }));
  return (ux, uy) =>
    Math.max(...spots.map((s) => clamp01(1.3 * (1 - Math.hypot(ux - s.cx, uy - s.cy) / s.rad))));
}

function band(r: () => number): Field {
  const x0 = between(r, 1, 11);
  const x1 = x0 + between(r, -2, 7);
  const width = between(r, 1.9, 3.4);
  const dx = x1 - x0;
  const dy = UH + 2;
  const len = Math.hypot(dx, dy);
  return (ux, uy) => {
    const d = Math.abs(dy * (ux - x0) - dx * (uy + 1)) / len;
    return clamp01(1.15 * (1 - d / width));
  };
}

function terrain(r: () => number): Field {
  const base = between(r, 3.6, 6.4);
  const a1 = between(r, 0.6, 1.8);
  const f1 = between(r, 0.3, 0.8);
  const p1 = between(r, 0, Math.PI * 2);
  const a2 = between(r, 0.2, 0.7);
  const f2 = between(r, 1.1, 2.2);
  const p2 = between(r, 0, Math.PI * 2);
  return (ux, uy) => {
    const top = base + a1 * Math.sin(f1 * ux + p1) + a2 * Math.sin(f2 * ux + p2);
    return clamp01((uy - top) / 2.4 + 0.45);
  };
}

function wave(r: () => number): Field {
  const mid = between(r, 3, 6);
  const amp = between(r, 0.5, 1.6);
  const freq = between(r, 0.35, 0.9);
  const phase = between(r, 0, Math.PI * 2);
  const width = between(r, 0.9, 1.9);
  return (ux, uy) => clamp01(1.15 * (1 - Math.abs(uy - (mid + amp * Math.sin(freq * ux + phase))) / width));
}

const MOTIFS = [blobs, band, terrain, wave] as const;
export const MOTIF_NAMES = ["blobs", "band", "terrain", "wave"] as const;

export type Face = { cols: number; rows: number; d: string; motif: (typeof MOTIF_NAMES)[number] };

const cache = new Map<string, Face>();

/** The face of an id on a cols x rows grid (48 x 27 for tiles, 32 x 18 for small faces). */
export function projectFace(id: string, cols = 48, rows = 27): Face {
  const key = `${id}:${cols}x${rows}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const r = byteStream(id);
  const pick = Math.floor(r() * MOTIFS.length) % MOTIFS.length;
  const field = MOTIFS[pick](r);

  let d = "";
  for (let y = 0; y < rows; y++) {
    let runStart = -1;
    for (let x = 0; x <= cols; x++) {
      let on = false;
      if (x < cols) {
        const v = field(((x + 0.5) / cols) * UW, ((y + 0.5) / rows) * UH);
        on = v > (BAYER4[y % 4][x % 4] + 0.5) / 16;
      }
      if (on && runStart < 0) runStart = x;
      if (!on && runStart >= 0) {
        d += `M${runStart} ${y}h${x - runStart}v1h-${x - runStart}z`;
        runStart = -1;
      }
    }
  }
  const face: Face = { cols, rows, d, motif: MOTIF_NAMES[pick] };
  if (cache.size > 5000) cache.clear();
  cache.set(key, face);
  return face;
}
