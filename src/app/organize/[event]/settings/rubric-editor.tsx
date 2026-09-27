"use client";

import { useCallback, useState } from "react";
import { RowsEditor, type RowField } from "@/components/rows-editor";

type Criterion = { id?: string; label: string; prompt: string; weight: number };
type Row = Record<string, string | number | boolean | undefined> & { id?: string };

const FIELDS: RowField[] = [
  { key: "label", label: "Criterion", type: "text", width: "w-40" },
  { key: "prompt", label: "Question for the judge", type: "text" },
  { key: "weight", label: "Weight", type: "number", width: "w-20" },
];

/**
 * The rubric's rows under Fig. 01, each criterion's share of a review's total drawn as one bar.
 * The bar starts from the saved weights and follows the weight fields as they are typed, so an
 * organizer sees what 1, 1 and 2 mean before saving; while it differs from what is saved it says so.
 */
export function RubricEditor({ saved, locked, lockedHint }: { saved: Criterion[]; locked: boolean; lockedHint: string }) {
  const [rows, setRows] = useState<Row[]>(saved);
  const onRowsChange = useCallback((r: Row[]) => setRows(r), []);
  const parts = rows
    .filter((r) => r.id !== undefined || String(r.label ?? "").trim() !== "")
    .map((r, i) => ({ key: r.id ?? `new-${i}`, label: String(r.label ?? "").trim() || "Untitled", weight: Number(r.weight) }));
  const usable = parts.length > 0 && parts.every((p) => Number.isFinite(p.weight) && p.weight > 0);
  const total = usable ? parts.reduce((s, p) => s + p.weight, 0) : 0;
  const same =
    parts.length === saved.length &&
    parts.every((p, i) => p.weight === saved[i].weight && p.label === saved[i].label.trim());
  return (
    <div className="flex flex-col gap-5">
      <figure className="flex flex-col gap-2">
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-12 text-ink-2">
          <span className="label-mono text-ink">Fig. 01 — Each criterion&rsquo;s share of a review</span>
          <span aria-live="polite">{same ? "as saved" : usable ? "not saved yet: the shares once you save" : "every weight must be above 0"}</span>
        </figcaption>
        {usable ? (
          <div className="flex w-full gap-[2px]">
            {parts.map((p, i) => (
              <div key={p.key} className="flex min-w-0 flex-col gap-1.5" style={{ flexGrow: p.weight, flexBasis: 0 }}>
                <span
                  className={`flex h-8 items-center px-2 text-13 font-medium tnum ${same ? `text-surface ${i % 2 ? "bg-ink-2" : "bg-ink"}` : "border-2 border-dashed border-ink bg-surface text-ink"}`}
                >
                  {Math.round((p.weight / total) * 100)} %
                </span>
                <span className="truncate text-12 text-ink-2" title={p.label}>
                  {p.label} <span className="text-ink-3 tnum">× {p.weight}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div aria-hidden className="h-8 border border-dashed border-flag-bar bg-flag-bg" />
        )}
      </figure>
      <RowsEditor
        name="rubric"
        initial={saved}
        blank={{ label: "", prompt: "", weight: 1 }}
        addLabel="Add a criterion"
        grid="lg:grid-cols-[20px_minmax(0,11rem)_minmax(0,1fr)_5rem_92px]"
        locked={locked}
        lockedHint={lockedHint}
        fields={FIELDS}
        onRowsChange={onRowsChange}
      />
    </div>
  );
}
