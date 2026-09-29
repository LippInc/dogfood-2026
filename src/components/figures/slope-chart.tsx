// Rank with every judge (left) against rank without the judges the engine leaves out
// (right), one line per project; the largest move is drawn in the accent.

type Row = { id: string; title: string; from: number; to: number };

export function SlopeChart({ rows, total, highlight, label }: { rows: Row[]; total: number; highlight: string | null; label: string }) {
  const W = 260;
  // the axis labels sit below the plot with room for their descenders inside the viewBox
  const H = 184;
  const top = 14;
  const bottom = 166;
  const y = (rank: number) => top + ((rank - 1) / Math.max(1, total - 1)) * (bottom - top);
  const hl = rows.find((r) => r.id === highlight);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[320px]" role="img" aria-label={label}>
      <line x1={60} x2={60} y1={top} y2={bottom} className="stroke-rule" />
      <line x1={200} x2={200} y1={top} y2={bottom} className="stroke-rule" />
      {rows.map((r) =>
        r.id === highlight ? null : (
          <line
            key={r.id}
            x1={60}
            y1={y(r.from)}
            x2={200}
            y2={y(r.to)}
            className={Math.abs(r.to - r.from) >= 1 ? "stroke-ink-2" : "stroke-rule"}
            strokeWidth={Math.abs(r.to - r.from) >= 1 ? 1 : 0.75}
          />
        ),
      )}
      {hl ? (
        <>
          <line x1={60} y1={y(hl.from)} x2={200} y2={y(hl.to)} className="stroke-accent" strokeWidth={2.5} />
          <text x={54} y={y(hl.from) + 4} textAnchor="end" className="fill-ink text-[11px] font-semibold">
            {hl.from}
          </text>
          <text x={206} y={y(hl.to) + 4} className="fill-ink text-[11px] font-semibold">
            {hl.to}
          </text>
        </>
      ) : null}
      <text x={60} y={H - 6} textAnchor="middle" className="fill-ink-3 text-[10px]">
        all judges
      </text>
      <text x={200} y={H - 6} textAnchor="middle" className="fill-ink-3 text-[10px]">
        without
      </text>
    </svg>
  );
}

/** A rank line 1…total with marked places. */
export function RankLine({ marks, total, label }: { marks: { rank: number; text: string }[]; total: number; label: string }) {
  const W = 320;
  const x = (rank: number) => 10 + ((rank - 1) / Math.max(1, total - 1)) * (W - 20);
  return (
    <svg viewBox={`0 0 ${W} 56`} className="w-full max-w-[360px]" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <line key={i} x1={x(i + 1)} x2={x(i + 1)} y1={22} y2={i % 10 === 9 || i === 0 ? 32 : 28} className="stroke-edge" />
      ))}
      {marks.map((m) => (
        <g key={m.text}>
          <circle cx={x(m.rank)} cy={25} r={5} className="fill-accent" />
          <text x={x(m.rank)} y={12} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
            {m.text}
          </text>
        </g>
      ))}
      <text x={x(1)} y={50} textAnchor="middle" className="fill-ink-3 text-[10px]">
        1
      </text>
      <text x={x(total)} y={50} textAnchor="middle" className="fill-ink-3 text-[10px]">
        {total}
      </text>
    </svg>
  );
}
