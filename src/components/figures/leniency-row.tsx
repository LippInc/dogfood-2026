// One judge's leniency drawn on a shared axis, for the ledger's rows: a hollow dot
// at their plain tilt (how far their scores sit from their co-reviewers'), a solid
// dot at the leniency the engine keeps, joined by the shrink, and a bar of two
// standard errors either side of it. A bar that crosses zero is a leniency that
// cannot be told apart from none. Server-rendered SVG from the engine's numbers.

const W = 220;
const H = 20;
const PAD = 8;

const at = (v: number, span: number) => PAD + ((v + span) / (2 * span)) * (W - 2 * PAD);

/** The largest value the axis must hold, rounded up to a half point. */
export function leniencySpan(values: number[]): number {
  const m = Math.max(0.5, ...values.map((v) => Math.abs(v)));
  return Math.ceil(m * 2) / 2;
}

export function LeniencyRow({ tilt, leniency, se, span }: { tilt: number | null; leniency: number; se: number | null; span: number }) {
  const clamp = (v: number) => Math.max(-span, Math.min(span, v));
  const lo = se === null ? null : at(clamp(leniency - 2 * se), span);
  const hi = se === null ? null : at(clamp(leniency + 2 * se), span);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" aria-hidden="true" focusable="false">
      <line x1={at(0, span)} x2={at(0, span)} y1={1} y2={H - 1} className="stroke-rule" strokeDasharray="2 2" />
      {lo !== null && hi !== null ? <rect x={lo} y={H / 2 - 5} width={Math.max(1, hi - lo)} height={10} className="fill-sunken stroke-edge" strokeWidth={0.75} /> : null}
      {tilt !== null ? (
        <>
          <line x1={at(clamp(tilt), span)} x2={at(clamp(leniency), span)} y1={H / 2} y2={H / 2} className="stroke-ink-3" strokeWidth={1} />
          <circle cx={at(clamp(tilt), span)} cy={H / 2} r={3.5} className="fill-surface stroke-ink-2" strokeWidth={1.25} />
        </>
      ) : null}
      <circle cx={at(clamp(leniency), span)} cy={H / 2} r={3.5} className="fill-ink" />
    </svg>
  );
}

/** The shared axis for the column head: harsher on the left, more lenient on the right. */
export function LeniencyAxis({ span }: { span: number }) {
  return (
    <svg viewBox={`0 0 ${W} 17`} width={W} height={17} className="block" aria-hidden="true" focusable="false">
      <line x1={PAD} x2={W - PAD} y1={3} y2={3} className="stroke-edge" />
      {[-span, 0, span].map((v) => (
        <g key={v}>
          <line x1={at(v, span)} x2={at(v, span)} y1={0} y2={6} className="stroke-edge" />
          <text x={at(v, span)} y={13.5} textAnchor={v < 0 ? "start" : v > 0 ? "end" : "middle"} className="fill-ink-3 font-mono text-[9px]">
            {v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`}
          </text>
        </g>
      ))}
    </svg>
  );
}
