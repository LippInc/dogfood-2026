import type { CSSProperties } from "react";

/**
 * FIG. 03, one row of it: a project's published score (the solid dot) with its ± one
 * standard error (the bar), and, for the score engine, the plain average of every
 * review it got (the ring) before judge leniency was taken out. Every value is the
 * stored run's own; the figure only places them on the event's common scale.
 * Decorative for screen readers: the same numbers are in the row's text.
 */

export type Scale = { lo: number; hi: number; ticks: number[]; percent: boolean };

/** One scale for the whole event, snapped to round steps, so tracks compare at a glance. */
export function scaleFor(values: number[], percent: boolean): Scale {
  const step = percent ? 0.1 : 0.5;
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return { lo: 0, hi: 1, ticks: [0, 1], percent };
  let lo = Math.floor(Math.min(...finite) / step) * step;
  let hi = Math.ceil(Math.max(...finite) / step) * step;
  if (hi - lo < step) hi = lo + step;
  if (percent) {
    lo = Math.max(0, lo);
    hi = Math.min(1, hi);
  }
  const ticks: number[] = [];
  const every = (hi - lo) / step > 6 ? step * 2 : step;
  for (let v = Math.ceil(lo / every - 1e-9) * every; v <= hi + 1e-9; v += every) ticks.push(Number(v.toFixed(4)));
  return { lo, hi, ticks, percent };
}

const at = (s: Scale, v: number) => `${(((v - s.lo) / (s.hi - s.lo)) * 100).toFixed(3)}%`;

export const tickLabel = (s: Scale, v: number) => (s.percent ? `${Math.round(v * 100)} %` : v.toFixed(1));

/** The tick labels above a track's rows. */
export function ScaleAxis({ scale }: { scale: Scale }) {
  return (
    <span className="relative block h-4" aria-hidden="true">
      {scale.ticks.map((t) => (
        <span key={t} className="absolute top-0 -translate-x-1/2 font-mono text-12 leading-4 text-ink-3" style={{ left: at(scale, t) }}>
          {tickLabel(scale, t)}
        </span>
      ))}
    </span>
  );
}

export function ScoreLine({
  scale,
  score,
  se,
  raw,
  first,
  index,
}: {
  scale: Scale;
  score: number | null;
  se: number | null;
  raw: number | null;
  first: boolean;
  index: number;
}) {
  if (score === null) return <span className="block h-5" aria-hidden="true" />;
  const from = raw ?? score;
  return (
    <span className="relative block h-5" aria-hidden="true">
      {scale.ticks.map((t) => (
        <span key={t} className="absolute inset-y-0.5 w-px bg-rule" style={{ left: at(scale, t) }} />
      ))}
      {se !== null ? (
        <span
          className={`draw absolute top-1/2 h-2 -translate-y-1/2 border-x ${first ? "border-accent" : "border-ink-3"}`}
          style={{ left: at(scale, score - se), width: `calc(${at(scale, score + se)} - ${at(scale, score - se)})`, "--i": index } as CSSProperties}
        >
          <span className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 ${first ? "bg-accent" : "bg-ink-3"}`} />
        </span>
      ) : null}
      <span
        className={`settle absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${first ? "bg-accent" : "bg-ink"}`}
        style={{ left: at(scale, score), "--from": at(scale, from), "--i": index } as CSSProperties}
      />
      {raw !== null ? (
        // A ring round the dot, drawn over it: where leniency moved a score less than a dot's width, the ring still shows the raw average.
        <span
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-ink-2"
          style={{ left: at(scale, raw) }}
        />
      ) : null}
    </span>
  );
}
