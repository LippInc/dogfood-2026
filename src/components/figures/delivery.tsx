// One webhook delivery, drawn: the portal POSTs the audited action to your URL,
// signed, and a failed try is repeated on a fixed schedule until it arrives or the
// tries run out. The schedule is drawn on a log time line, so ten seconds and two
// hours both have room. Server-rendered SVG; the delays come from the caller.

const W = 1000;
const H = 150;

function span(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function Delivery({ delays }: { delays: readonly number[] }) {
  // the time of each try since the first, and a log scale from 1 s to the last try
  const at = delays.reduce<number[]>((acc, d) => [...acc, acc.at(-1)! + d], [0]);
  const last = at.at(-1)!;
  const x0 = 250;
  const x1 = W - 40;
  const x = (t: number) => (t === 0 ? x0 : x0 + 40 + (Math.log10(t) / Math.log10(last)) * (x1 - x0 - 40));
  const y = 112;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full"
      role="img"
      aria-label={`A delivery is tried at once, then again after ${delays.map(span).join(", ")}: ${at.length} tries in all, the last ${span(last)} after the first.`}
    >
      <defs>
        <marker id="delivery-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8z" className="fill-ink" />
        </marker>
      </defs>
      {/* the two ends and the signed request between them */}
      <rect x={1} y={14} width={150} height={44} className="fill-surface stroke-ink" strokeWidth={1.5} />
      <text x={76} y={41} textAnchor="middle" className="fill-ink font-mono text-[13px]">
        this portal
      </text>
      <rect x={W - 191} y={14} width={190} height={44} className="fill-surface stroke-ink" strokeWidth={1.5} />
      <text x={W - 96} y={41} textAnchor="middle" className="fill-ink font-mono text-[13px]">
        your URL
      </text>
      <line x1={152} x2={W - 196} y1={36} y2={36} className="stroke-ink" strokeWidth={1.5} markerEnd="url(#delivery-arrow)" />
      <text x={(152 + W - 196) / 2} y={28} textAnchor="middle" className="fill-ink-2 font-mono text-[12px]">
        POST application/json · Dogfood-Signature: t=…,v1=HMAC-SHA256(secret, t.body)
      </text>
      <text x={(152 + W - 196) / 2} y={54} textAnchor="middle" className="fill-ink-3 text-[11px]">
        the body carries the action and its audit row&rsquo;s hash
      </text>

      {/* the tries on a log time line */}
      <text x={0} y={y + 4} className="fill-ink-2 text-[12px]">
        if a try fails, again after
      </text>
      <line x1={x0} x2={x1} y1={y} y2={y} className="stroke-edge" />
      {at.map((t, i) => (
        <g key={t}>
          <rect x={x(t) - 5} y={y - 5} width={10} height={10} className={i === 0 ? "fill-ink" : "fill-surface stroke-ink"} strokeWidth={1.5} />
          <text x={x(t)} y={y - 12} textAnchor="middle" className="fill-ink font-mono text-[11px]">
            {i === 0 ? "try 1" : `+${span(delays[i - 1]!)}`}
          </text>
          <text x={x(t)} y={y + 22} textAnchor="middle" className="fill-ink-3 font-mono text-[10px]">
            {i === 0 ? "0" : span(t)}
          </text>
        </g>
      ))}
      <text x={x1} y={H - 2} textAnchor="end" className="fill-ink-3 text-[10px]">
        time since the first try, on a log scale · after try {at.length}, the delivery is marked failed
      </text>
    </svg>
  );
}
