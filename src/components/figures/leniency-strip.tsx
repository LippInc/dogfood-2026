// Each judge twice: a hollow dot where the plain average puts their leniency (how far
// their scores sit from their co-reviewers') and a solid dot where the engine keeps
// it after shrinking by n ÷ (n + k). A server-rendered SVG from the engine's numbers.

type Point = { name: string; n: number; tilt: number; leniency: number };

export function LeniencyStrip({ points, label }: { points: Point[]; label: string }) {
  if (points.length === 0) return <p className="text-13 text-ink-2">No judge has a co-reviewer yet, so there is nothing to draw.</p>;
  const W = 400;
  const H = 136;
  const pad = 14;
  const span = Math.max(0.5, ...points.map((p) => Math.abs(p.tilt)), ...points.map((p) => Math.abs(p.leniency)));
  const x = (v: number) => pad + ((v + span) / (2 * span)) * (W - 2 * pad);
  // Stack hollow dots that would overlap.
  const placed: { cx: number; cy: number }[] = [];
  const top = [...points]
    .sort((a, b) => a.tilt - b.tilt)
    .map((p) => {
      const cx = x(p.tilt);
      let cy = 30;
      while (placed.some((q) => Math.abs(q.cx - cx) < 8 && Math.abs(q.cy - cy) < 8)) cy += 8;
      placed.push({ cx, cy });
      return { ...p, cx, cy };
    });
  const extreme = top.reduce((a, b) => (Math.abs(b.tilt) > Math.abs(a.tilt) ? b : a));
  const maxKept = Math.max(...points.map((p) => Math.abs(p.leniency)));
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
        <line x1={x(0)} x2={x(0)} y1={12} y2={H - 16} className="stroke-rule" strokeDasharray="2 3" />
        {top.map((p) => (
          <line key={`l-${p.name}`} x1={p.cx} y1={p.cy} x2={x(p.leniency)} y2={H - 30} className="stroke-ink-3" strokeOpacity={0.45} strokeWidth={0.75} />
        ))}
        {top.map((p) => (
          <circle key={`t-${p.name}`} cx={p.cx} cy={p.cy} r={3.5} className="fill-surface stroke-ink-2" strokeWidth={1.25} />
        ))}
        {points.map((p) => (
          <circle key={`b-${p.name}`} cx={x(p.leniency)} cy={H - 30} r={3.5} className="fill-ink" />
        ))}
        <text x={extreme.cx + (extreme.tilt < 0 ? -4 : 4)} y={extreme.cy - 9} textAnchor={extreme.tilt < 0 ? "start" : "end"} className="fill-ink-2 text-[11px]">
          {extreme.name}, {extreme.n} {extreme.n === 1 ? "review" : "reviews"}
        </text>
        <text x={x(0)} y={H - 4} textAnchor="middle" className="fill-ink-2 font-mono text-[10px]">
          0
        </text>
        <text x={x(0) + 10} y={H - 26} className="fill-ink-2 text-[11px]">
          all {points.length} within ±{maxKept.toFixed(2)}
        </text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-12 text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full border border-ink-2" aria-hidden /> a plain average&rsquo;s idea of leniency
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full bg-ink" aria-hidden /> what the data supports
        </span>
      </figcaption>
    </figure>
  );
}
