import Link from "next/link";
import type { About } from "@/server/dal";

type Criterion = About["rubric"][number];

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
/** One dither density per criterion (of 16), so neighbouring segments read apart even at equal weights. */
const LEVELS = [8, 4, 12, 2, 10, 6, 14, 1];

/** A segment's fill: the project faces' 4 x 4 Bayer dither in 3 px cells. Decorative. */
function Dither({ id, level }: { id: string; level: number }) {
  const cells: [number, number][] = [];
  BAYER4.forEach((row, y) => row.forEach((t, x) => (t < level ? cells.push([x, y]) : null)));
  return (
    <svg className="absolute inset-0 size-full" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse">
          {cells.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x * 3} y={y * 3} width="3" height="3" className="fill-face-dot" />
          ))}
        </pattern>
      </defs>
      <rect width="100%" height="100%" className="fill-face-bg" />
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/** The judge's joined score buttons, drawn as a picture of the scale: one box per point. */
function Scale({ min, max }: { min: number; max: number }) {
  const points = Array.from({ length: Math.min(max - min + 1, 11) }, (_, i) => min + i);
  return (
    <span className="mt-3 inline-flex sm:mt-0" aria-hidden="true">
      {points.map((p) => (
        <span key={p} className="-ml-px flex size-8 items-center justify-center border border-edge font-mono text-12 text-ink-3 first:ml-0 first:rounded-l-sm last:rounded-r-sm">
          {p}
        </span>
      ))}
    </span>
  );
}

/**
 * FIG. 02: how a review's total is made. The weight bar splits 100 % of the total by each
 * criterion's weight (the organizer's setting, read from its row); the rows name each
 * criterion with its scale; the sum spells out the weighted mean with the same shares.
 */
export function Rubric({ rubric, shares, resultsHref }: { rubric: Criterion[]; shares: string[]; resultsHref: string }) {
  const min = rubric[0]?.scaleMin ?? 1;
  const max = rubric[0]?.scaleMax ?? 5;
  const n = (i: number) => String(i + 1).padStart(2, "0");
  return (
    <div className="mt-8 grid gap-10 lg:grid-cols-3 lg:gap-12">
      <div>
        <p className="text-15 text-ink-2">
          Each judge scores every criterion from {min} to {max}. A review&apos;s total is the weighted mean of its criteria, with
          the weights the organizers set:
        </p>
        <div className="mt-5 rounded-sm bg-sunken p-4 font-mono text-13 text-ink-2 tnum">
          <p className="label-mono text-ink-3">Review total</p>
          <ol className="mt-2 flex flex-col gap-1">
            {rubric.map((c, i) => (
              <li key={c.key} className="flex gap-2 wrap-anywhere">
                <span className="w-3 shrink-0 text-ink-3">{i === 0 ? "=" : "+"}</span>
                <span>
                  <span className="text-ink">{shares[i]}</span> × {c.label}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="mt-6 text-15 text-ink-2">
          Before ranking, the portal evens out judges who score harshly or generously, and shows its working next to every
          result.
        </p>
        <Link href={resultsHref} className="mt-3 inline-flex items-center gap-1.5 text-15 font-medium underline decoration-edge hover:decoration-ink">
          How the results are shown <span aria-hidden>→</span>
        </Link>
      </div>
      <div className="flex flex-col gap-6 lg:col-span-2">
        <div aria-hidden="true" className="flex h-12 gap-[3px]">
          {rubric.map((c, i) => (
            <div key={c.key} className="relative min-w-10 overflow-hidden rounded-xs" style={{ flexGrow: c.weight, flexBasis: 0 }}>
              <Dither id={`weight-${c.key}`} level={LEVELS[i % LEVELS.length]} />
              <span className="absolute top-1.5 left-1.5 rounded-xs bg-surface px-1.5 font-mono text-12 leading-5 whitespace-nowrap text-ink">
                {n(i)}
                <span className="hidden sm:inline">
                  {" "}
                  <span className="text-ink-3">·</span> {shares[i]}
                </span>
              </span>
            </div>
          ))}
        </div>
        <ol className="flex flex-col divide-y divide-rule border-y border-rule">
          {rubric.map((c, i) => (
            <li key={c.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 py-4 wrap-anywhere sm:grid-cols-[auto_1fr_auto_auto] sm:gap-x-6">
              <span className="self-start pt-1 font-mono text-12 text-ink-3">{n(i)}</span>
              <div className="min-w-0 self-start">
                <h3 className="text-17 font-semibold">{c.label}</h3>
                {c.prompt ? <p className="mt-1 text-15 text-ink-2">{c.prompt}</p> : null}
                <span className="sr-only">
                  Scored {c.scaleMin} to {c.scaleMax}.
                </span>
              </div>
              <div className="col-start-2 row-start-2 sm:col-start-3 sm:row-start-1">
                <Scale min={c.scaleMin} max={c.scaleMax} />
              </div>
              <p className="col-start-3 row-start-1 self-start text-right sm:col-start-4">
                <span className="block text-24 font-semibold tnum">{shares[i]}</span>
                <span className="label-mono text-ink-3">of the total</span>
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
