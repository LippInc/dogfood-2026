// When the projects came in: one cell per submitted project, stacked in three-hour
// bins on a time line that ends at the close. Cells of suspected duplicates are
// orange. The last arrival is labelled with its distance from the close. A
// server-rendered SVG from the submission times the page already reads.

type Arrival = { id: string; title: string; at: string; flagged: boolean };

const HOUR = 3_600_000;
const BIN = 3 * HOUR;
const W = 1000;
const PAD_L = 4;
const PAD_R = 4;
const CELL_H = 7;
const GAP = 2;
const TOP = 26;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function before(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min before the close`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h before the close` : `${Math.round(h / 24)} days before the close`;
}

export function Arrivals({ arrivals, closeAt }: { arrivals: Arrival[]; closeAt: string }) {
  if (arrivals.length === 0) return null;
  const close = Date.parse(closeAt);
  const times = arrivals.map((a) => Date.parse(a.at));
  const first = Math.min(...times);
  // from the midnight (UTC) before the first arrival to the close, or to the last arrival if later
  const start = Math.floor(first / (24 * HOUR)) * 24 * HOUR;
  const end = Math.max(close, ...times);
  const bins = Math.max(1, Math.ceil((end - start) / BIN));
  const binW = (W - PAD_L - PAD_R) / bins;
  const x = (t: number) => PAD_L + ((t - start) / (bins * BIN)) * (W - PAD_L - PAD_R);
  const stacks = new Map<number, Arrival[]>();
  arrivals
    .map((a, i) => ({ a, t: times[i]! }))
    .sort((p, q) => p.t - q.t)
    .forEach(({ a, t }) => {
      const b = Math.min(bins - 1, Math.floor((t - start) / BIN));
      stacks.set(b, [...(stacks.get(b) ?? []), a]);
    });
  const tallest = Math.max(...[...stacks.values()].map((s) => s.length));
  const base = TOP + tallest * (CELL_H + GAP);
  const H = base + 22;
  const days: number[] = [];
  for (let d = start; d <= end; d += 24 * HOUR) days.push(d);
  const lastT = Math.max(...times);
  const last = arrivals[times.indexOf(lastT)]!;
  const lastBin = Math.min(bins - 1, Math.floor((lastT - start) / BIN));
  const lastTop = base - (stacks.get(lastBin)!.length) * (CELL_H + GAP);
  const date = (t: number) => {
    const d = new Date(t);
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  };
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full"
      role="img"
      aria-label={`${arrivals.length} projects submitted between ${new Date(first).toUTCString()} and ${new Date(lastT).toUTCString()}; the last, ${last.title}, ${before(close - lastT)}.`}
    >
      {days.map((d) => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={TOP - 6} y2={base + 4} className="stroke-rule" />
          <text x={x(d) + 4} y={base + 16} className="fill-ink-3 font-mono text-[10px]">
            {date(d)}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - PAD_R} y1={base + 0.5} y2={base + 0.5} className="stroke-edge" />
      {[...stacks.entries()].flatMap(([b, list]) =>
        list.map((a, i) => (
          <rect
            key={a.id}
            x={PAD_L + b * binW + 1}
            y={base - (i + 1) * (CELL_H + GAP) + GAP / 2}
            width={Math.max(2, binW - 2)}
            height={CELL_H}
            className={a.flagged ? "fill-flag-bar" : "fill-ink"}
          >
            <title>{`${a.title}, ${new Date(Date.parse(a.at)).toUTCString().replace(":00 GMT", " UTC")}`}</title>
          </rect>
        )),
      )}
      <line x1={x(close)} x2={x(close)} y1={4} y2={base + 4} className="stroke-ink" strokeWidth={1.5} strokeDasharray="3 2" />
      <text x={x(close) + 4} y={base + 16} textAnchor="end" className="fill-ink font-mono text-[10px]">
        close
      </text>
      {/* the last arrival, named on the close's line with a leader down to its cell */}
      <line x1={PAD_L + (lastBin + 0.5) * binW} x2={PAD_L + (lastBin + 0.5) * binW} y1={16} y2={lastTop - 1} className="stroke-ink-3" />
      <text x={PAD_L + (lastBin + 0.5) * binW - 6} y={12} textAnchor="end" className="fill-ink-2 text-[11px]">
        last: {last.title}, {before(close - lastT)}
      </text>
    </svg>
  );
}
