import type { Yardstick } from "@/server/dal";

const f2 = (x: number) => x.toFixed(2);

/**
 * The organizers' own normalization yardstick in one plain paragraph: how far apart the
 * judges' averages are, how far apart judges with no tilt would be on the same projects,
 * and what the engine leaves. With `figure`, the fair judges' band as a small drawing.
 */
export function YardstickLine({ y, figure = false }: { y: Yardstick; figure?: boolean }) {
  const lucky = y.raw <= y.fair.high;
  const top = Math.max(y.fair.high, y.raw, y.after) * 1.15;
  const x = (v: number) => 10 + (v / top) * 300;
  return (
    <div>
      <p className="text-14">
        <strong>The judges&rsquo; own averages are {f2(y.raw)} apart</strong> (the standard deviation across the {y.judges} judges counted, the organizers&rsquo;
        yardstick for normalization). Judges with no tilt at all, scoring these same projects, would be about {f2(y.fair.median)} apart by luck alone (90 % of
        the time between {f2(y.fair.low)} and {f2(y.fair.high)}),{" "}
        {lucky ? "so this spread is what luck alone gives" : "so this spread is wider than luck alone gives: some judges are more lenient than others"}. The
        engine takes out the leniency the projects judges share show, at most {f2(y.largestLeniency)} for any judge, which leaves {f2(y.after)}.
      </p>
      {figure ? (
        <>
          <svg
            viewBox="0 0 320 34"
            className="mt-3 w-full max-w-[360px]"
            role="img"
            aria-label={`Fair judges' band ${f2(y.fair.low)} to ${f2(y.fair.high)}; the judges' spread ${f2(y.raw)} before and ${f2(y.after)} after the engine`}
          >
            <rect x={10} y={13.5} width={300} height={1} className="fill-edge" />
            <rect x={x(y.fair.low)} y={9} width={x(y.fair.high) - x(y.fair.low)} height={10} className="fill-sunken stroke-edge" strokeWidth={0.5} />
            <line x1={x(y.fair.median)} x2={x(y.fair.median)} y1={7} y2={21} className="stroke-ink-3" strokeWidth={1} />
            <circle cx={x(y.raw)} cy={14} r={4.5} className="fill-surface stroke-ink" strokeWidth={1.5} />
            <circle cx={x(y.after)} cy={14} r={4.5} className="fill-ink" />
            <text x={10} y={31} textAnchor="middle" className="fill-ink-3 text-[9px]">
              0
            </text>
            <text x={x(y.fair.low)} y={31} className="fill-ink-3 text-[9px]">
              luck alone, 90 %
            </text>
          </svg>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-12 text-ink-2" aria-hidden>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full border border-ink" /> the judges&rsquo; spread, {f2(y.raw)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-ink" /> after the engine, {f2(y.after)}
            </span>
          </p>
        </>
      ) : null}
    </div>
  );
}
