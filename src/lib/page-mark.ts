import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

// Page marks: every page carries a small 1-bit pattern of its own, in the project
// faces' language (SHA-256 of a seed picks a motif and its geometry, a 4x4 Bayer
// matrix dithers it into cells). The seed is the page's address: its route plus the
// one thing it shows (an event, a project, a record), so the gallery, a project page
// and the next project page each get a different mark, and the same page always gets
// the same one. Where the address carries a secret (an invite code, a reset token) the
// secret is left out. Unlike a face, a mark fades out from the edge it is anchored to,
// the way the dithered band fades on the demo video's drawing sheets, and its cells
// stand apart with a hairline gap, so it reads as a grid of pixels.

/** The request header src/proxy.ts sets on every page request: the page's path. */
export const PAGE_PATH_HEADER = "x-dogfood-page";

/** First path segments whose second segment is a secret: blanked before hashing. */
const SECRET_ROOTS = new Set(["claim", "reset", "join", "judge-invite", "vote"]);

/** The seed of a page: its path with any secret blanked, plus an optional extra (a refusal's status). */
export function pageSeed(path: string | null | undefined, extra = ""): string {
  const clean = path && path.startsWith("/") && path.length <= 512 ? path : "/";
  const segments = clean.split("/").filter(Boolean);
  if (segments.length >= 2 && SECRET_ROOTS.has(segments[0]!)) segments[1] = "[secret]";
  return `/${segments.join("/")}${extra ? `#${extra}` : ""}`;
}

/** Which edge the mark is dense at: it fades towards the opposite side. */
export type MarkAnchor = "right" | "left" | "top-right" | "bottom";

/** A drawn mark: SVG paths in cell units, and the on cells as a grid (1 per cell, row by row) for markPng. */
export type Mark = { cols: number; rows: number; d: string; lit: string; id: string; on: Uint8Array };

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// A cell covers 3/4 of its pitch: at 4 px a pitch, 3 px squares with 1 px between.
const CELL = 0.75;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function byteStream(seed: string): () => number {
  let block = createHash("sha256").update(`mark:${seed}`).digest();
  let i = 0;
  let round = 0;
  return () => {
    if (i >= block.length) {
      round += 1;
      block = createHash("sha256").update(`mark:${seed}:${round}`).digest();
      i = 0;
    }
    return block[i++]! / 255;
  };
}

const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

type Motif = (x: number, y: number) => number;

// Motifs are drawn along a long side W and a short side H, in cells: a tall mark is
// drawn lying down and turned upright. Sizes scale with H and wavelengths with L (H,
// stretched for long bands), so a wide band and a small corner draw the same kinds of
// shape at the same pixel size.

/** A ribbon that swings along the long side. */
function ribbon(r: () => number, W: number, H: number, L: number): Motif {
  const mid = between(r, 0.3, 0.7) * H;
  const amp = between(r, 0.15, 0.35) * H;
  const k = (Math.PI * 2) / (between(r, 1.6, 4.2) * L);
  const phase = between(r, 0, Math.PI * 2);
  const w = between(r, 0.14, 0.26) * H;
  return (x, y) => clamp01(1.2 * (1 - Math.abs(y - (mid + amp * Math.sin(k * x + phase))) / w));
}

/** A skyline: filled below a ridge of two waves. */
function ridge(r: () => number, W: number, H: number, L: number): Motif {
  const base = between(r, 0.35, 0.6) * H;
  const a1 = between(r, 0.15, 0.3) * H;
  const k1 = (Math.PI * 2) / (between(r, 2.5, 5) * L);
  const p1 = between(r, 0, Math.PI * 2);
  const a2 = between(r, 0.05, 0.14) * H;
  const k2 = k1 * between(r, 2.2, 3.6);
  const p2 = between(r, 0, Math.PI * 2);
  return (x, y) => clamp01((y - (base + a1 * Math.sin(k1 * x + p1) + a2 * Math.sin(k2 * x + p2))) / (0.35 * H) + 0.5);
}

/** Rings around a point, like ripples. */
function rings(r: () => number, W: number, H: number): Motif {
  const cx = between(r, 0.1, 0.9) * W;
  const cy = between(r, -0.3, 1.3) * H;
  const k = (Math.PI * 2) / (between(r, 0.45, 0.8) * H);
  const phase = between(r, 0, Math.PI * 2);
  return (x, y) => 0.5 + 0.5 * Math.cos(Math.hypot(x - cx, y - cy) * k + phase);
}

/** Hatching at an angle, like a section cut on a drawing. */
function hatch(r: () => number, W: number, H: number): Motif {
  const angle = between(r, 0.35, 1.2) * (r() < 0.5 ? 1 : -1);
  const k = (Math.PI * 2) / (between(r, 0.35, 0.6) * H);
  const phase = between(r, 0, Math.PI * 2);
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return (x, y) => clamp01(0.5 + 0.8 * Math.sin((x * c + y * sn) * k + phase));
}

/** Two or three soft spots (more on a long band, so they are not lost along it). */
function spots(r: () => number, W: number, H: number): Motif {
  const count = (r() < 0.5 ? 2 : 3) * Math.max(1, Math.round(W / (H * 6)));
  const list = Array.from({ length: count }, () => ({
    cx: between(r, 0.1, 0.9) * W,
    cy: between(r, 0.15, 0.85) * H,
    rad: between(r, 0.35, 0.6) * H,
  }));
  return (x, y) => Math.max(...list.map((p) => clamp01(1.3 * (1 - Math.hypot(x - p.cx, y - p.cy) / p.rad))));
}

const MOTIFS = [ribbon, ridge, rings, hatch, spots] as const;

/** How dense the mark may be at a cell: full over the part nearest its anchor edge, fading to 0 across the rest. */
function envelope(anchor: MarkAnchor, u: number, v: number): number {
  const fade = (t: number, full: number) => {
    const k = clamp01(t / full);
    return k * k * (3 - 2 * k);
  };
  if (anchor === "right") return fade(u, 0.65);
  if (anchor === "left") return fade(1 - u, 0.65);
  if (anchor === "bottom") return fade(v, 1) ** 1.5;
  return fade(u, 0.6) * fade(1 - v, 0.75);
}

/** How close a cell is to the anchor edge itself (1 on it): the edge is dithered in every mark. */
function nearness(anchor: MarkAnchor, u: number, v: number): number {
  if (anchor === "right") return u;
  if (anchor === "left") return 1 - u;
  if (anchor === "bottom") return v;
  return (1 - v) * clamp01(u / 0.6);
}

const cache = new Map<string, Mark>();

/** The mark of a seed on a cols x rows grid, as SVG paths in cell units. */
export function pageMark(seed: string, cols: number, rows: number, anchor: MarkAnchor): Mark {
  const key = `${seed}|${cols}x${rows}|${anchor}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const r = byteStream(seed);
  const id = createHash("sha256").update(`mark:${seed}`).digest("hex").slice(0, 8);
  const tall = rows > cols;
  const W = Math.max(cols, rows);
  const H = Math.min(cols, rows);
  const L = H * Math.min(2.5, Math.max(1, W / H / 2));
  const drawn = MOTIFS[Math.floor(r() * MOTIFS.length) % MOTIFS.length]!(r, W, H, L);
  const motif: Motif = tall ? (x, y) => drawn(y, x) : drawn;
  // One cell is lit in the accent, near the anchor edge: the portal's one pink square.
  const litAt = between(r, 0, 1);

  let d = "";
  const onCells: [number, number, number][] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const u = (x + 0.5) / cols;
      const v = (y + 0.5) / rows;
      const e = envelope(anchor, u, v);
      // the motif, faded by the envelope, over a dithered edge along the anchor side
      const level = Math.max(clamp01(1.25 * e * motif(x + 0.5, y + 0.5)), 0.5 * nearness(anchor, u, v) ** 10);
      if (level > (BAYER4[y % 4]![x % 4]! + 0.5) / 16) onCells.push([x, y, e]);
    }
  }
  const near = onCells.filter((c) => c[2] > 0.9);
  const lit = near.length ? near[Math.floor(litAt * near.length) % near.length]! : null;
  let litPath = "";
  const on = new Uint8Array(cols * rows);
  for (const [x, y] of onCells) {
    on[y * cols + x] = 1;
    const cell = `M${x} ${y}h${CELL}v${CELL}h-${CELL}z`;
    if (lit && lit[0] === x && lit[1] === y) litPath = cell;
    else d += cell;
  }
  const mark: Mark = { cols, rows, d, lit: litPath, id, on };
  if (cache.size > 2000) cache.clear();
  cache.set(key, mark);
  return mark;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * A mark as a 1-bit PNG with its off pixels transparent, for a CSS mask over a token
 * colour: a long band as an SVG path runs to tens of kilobytes on every page, as a PNG
 * to one or two. Drawn at `scale` image pixels per CSS pixel, so a cell stays a crisp
 * square on a high-density screen; `pitch` is the CSS size of a cell, whose square
 * covers all but one pixel of it (the same grid as the SVG marks).
 */
export function markPng(mark: Mark, pitch: number, scale = 2): string {
  const step = pitch * scale;
  const square = (pitch - 1) * scale;
  const width = mark.cols * step;
  const height = mark.rows * step;
  const stride = Math.ceil(width / 8) + 1;
  const raw = Buffer.alloc(stride * height);
  for (let py = 0; py < height; py++) {
    if (py % step >= square) continue;
    const y = Math.floor(py / step);
    for (let x = 0; x < mark.cols; x++) {
      if (!mark.on[y * mark.cols + x]) continue;
      for (let px = x * step; px < x * step + square; px++) raw[py * stride + 1 + (px >> 3)]! |= 0x80 >> (px & 7);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([1, 0, 0, 0, 0], 8); // 1-bit greyscale, no interlace
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tRNS", Buffer.from([0, 0])), // grey 0, the off pixels, is transparent
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}
