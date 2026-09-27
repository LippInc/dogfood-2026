"use client";

import { useLayoutEffect, useRef, useState } from "react";

// The overview's decisions drawn as wires into the Publish panel's lock, like a
// schematic: each decision row runs a wire to a bus in the gutter, and the bus
// runs to the lock. A wire is solid ink once its decision is made and dashed
// orange ("needs you") while it is open; a stretch of the bus is dashed while any
// decision it carries is open, so the lock's own wire turns solid only when every
// decision is made. Positions are measured from the page (rows grow when opened),
// on wide screens only; below that the panels stack and nothing is drawn.
//
// Markers: [data-wire-from] the decisions panel, [data-wire-source] each row (with
// data-open="true" while undecided), [data-wire-panel] the Publish panel, and
// [data-wire-target] the lock's frame inside it, where the wire ends. Purely decorative: aria-hidden, no
// pointer events, absolutely positioned (no layout shift).

type Seg = { d: string; open: boolean };
type Drawing = { segs: Seg[]; nodes: { x: number; y: number }[] };

const WIDE = "(min-width: 1024px)";

function measure(box: HTMLElement): Drawing | null {
  if (!window.matchMedia(WIDE).matches) return null;
  const from = box.querySelector<HTMLElement>("[data-wire-from]");
  const panel = box.querySelector<HTMLElement>("[data-wire-panel]");
  const target = box.querySelector<HTMLElement>("[data-wire-target]");
  const sources = [...box.querySelectorAll<HTMLElement>("[data-wire-source]")];
  if (!from || !panel || !target || sources.length === 0) return null;
  const b = box.getBoundingClientRect();
  const f = from.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  if (p.left <= f.right) return null; // stacked, not side by side
  const bus = Math.round((f.right + p.left) / 2 - b.left) + 0.5;
  const ty = Math.round(t.top + t.height / 2 - b.top) + 0.5;
  const tx = Math.round(t.left - b.left);
  const rows = sources.map((s) => {
    const r = s.getBoundingClientRect();
    return { x: Math.round(r.right - b.left) + 8, y: Math.round(r.top + r.height / 2 - b.top) + 0.5, open: s.dataset.open === "true" };
  });
  const segs: Seg[] = rows.map((r) => ({ d: `M${r.x} ${r.y}H${bus}`, open: r.open }));
  // The bus, stretch by stretch: each stretch carries the rows on its far side from the lock.
  const ys = [...new Set([...rows.map((r) => r.y), ty])].sort((a, c) => a - c);
  for (let i = 0; i < ys.length - 1; i++) {
    const [lo, hi] = [ys[i]!, ys[i + 1]!];
    const carried = rows.filter((r) => (ty <= lo ? r.y >= hi : r.y <= lo));
    // drawn toward the lock, so an open wire's dashes run into it
    segs.push({ d: ty <= lo ? `M${bus} ${hi}V${lo}` : `M${bus} ${lo}V${hi}`, open: carried.some((r) => r.open) });
  }
  segs.push({ d: `M${bus} ${ty}H${tx}`, open: rows.some((r) => r.open) });
  return { segs, nodes: rows.map((r) => ({ x: bus, y: r.y })) };
}

export function Wiring({ children }: { children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const inner = content.current;
    if (!el || !inner) return;
    let last = "";
    const draw = () => {
      const next = measure(el);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      setDrawing(next);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(inner);
    const mo = new MutationObserver(draw);
    mo.observe(inner, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-open", "aria-expanded", "class"] });
    const mq = window.matchMedia(WIDE);
    mq.addEventListener("change", draw);
    window.addEventListener("resize", draw);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", draw);
      window.removeEventListener("resize", draw);
    };
  }, []);
  return (
    <div ref={box} className="relative">
      <div ref={content}>{children}</div>
      {drawing ? (
        <svg aria-hidden="true" focusable="false" className="wiring pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {drawing.segs.map((s, i) => (
            <path key={i} d={s.d} className={s.open ? "wire wire-open" : "wire"} />
          ))}
          {drawing.nodes.map((n, i) => (
            <rect key={i} x={n.x - 3} y={n.y - 3} width={6} height={6} className="fill-ink" />
          ))}
        </svg>
      ) : null}
    </div>
  );
}
