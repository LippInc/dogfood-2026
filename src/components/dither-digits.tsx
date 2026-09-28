/**
 * An HTTP status drawn in the project faces' language: a 5 x 7 pixel figure for each
 * digit, every pixel a block of cells, outlined crisply and filled with a 4 x 4 Bayer
 * dither of a diagonal wave. Pure and deterministic, so the server and the error
 * boundary (a client component) draw the same picture. Decorative.
 */

const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
};

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const S = 6; // cells per font pixel

/** Optional ways to spoil the figure on purpose; left out, the drawing is the plain one. */
type Spoil = { hollow?: number[]; tear?: boolean };

/** Rows of cells shifted sideways, like a misregistered print: [first row, last row + 1, shift]. */
const TEARS: [number, number, number][] = [
  [18, 22, 6],
  [22, 24, -3],
];

function drawing(text: string, spoil: Spoil = {}): { w: number; h: number; d: string } {
  const glyphs = [...text].map((c) => FONT[c] ?? FONT["0"]);
  // the whole string as one pixel grid, one blank column between digits
  const cols = glyphs.length * 6 - 1;
  const ink = (px: number, py: number): boolean => {
    if (py < 0 || py > 6 || px < 0 || px >= cols) return false;
    const g = Math.floor(px / 6);
    const x = px % 6;
    return x < 5 && glyphs[g][py][x] === "1";
  };
  const w = cols * S;
  const h = 7 * S;
  let d = "";
  for (let cy = 0; cy < h; cy++) {
    let run = -1;
    const shift = spoil.tear ? (TEARS.find(([a, b]) => cy >= a && cy < b)?.[2] ?? 0) : 0;
    for (let cx = 0; cx <= w; cx++) {
      let on = false;
      const sx = cx - shift;
      if (cx < w && sx >= 0 && sx < w) {
        const px = Math.floor(sx / S);
        const py = Math.floor(cy / S);
        if (ink(px, py)) {
          const ix = sx % S;
          const iy = cy % S;
          const edge = (ix === 0 && !ink(px - 1, py)) || (ix === S - 1 && !ink(px + 1, py)) || (iy === 0 && !ink(px, py - 1)) || (iy === S - 1 && !ink(px, py + 1));
          const v = 0.66 + 0.34 * Math.sin((cx + 1.7 * cy) / 6);
          const hollow = spoil.hollow?.includes(Math.floor(px / 6)) ?? false;
          on = edge || (!hollow && v > (BAYER4[cy % 4][cx % 4] + 0.5) / 16);
        }
      }
      if (on && run < 0) run = cx;
      if (!on && run >= 0) {
        d += `M${run} ${cy}h${cx - run}v1h-${cx - run}z`;
        run = -1;
      }
    }
  }
  return { w, h, d };
}

export function DitherDigits({ value, className = "", spoil }: { value: string; className?: string; spoil?: Spoil }) {
  const digits = value.replace(/[^0-9]/g, "").slice(0, 3) || "0";
  const { w, h, d } = drawing(digits, spoil);
  const pad = 4;
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
      className={`block h-auto w-full ${className}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={-pad} y={-pad} width={w + pad * 2} height={h + pad * 2} className="fill-face-bg" />
      <path d={d} className="fill-face-dot" />
    </svg>
  );
}
