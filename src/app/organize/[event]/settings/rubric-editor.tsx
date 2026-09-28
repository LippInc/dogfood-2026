"use client";

import { useCallback, useState } from "react";
import { RowsEditor, type RowField } from "@/components/rows-editor";
import { Textarea } from "@/components/ui/textarea";
import { formatUtc } from "@/lib/format";
import { weightMoves } from "@/lib/weight-change";

type Criterion = { id?: string; label: string; prompt: string; weight: number };
type Change = { at: string; reason: string; before: { id: string; label: string; weight: number }[]; after: { id: string; label: string; weight: number }[] };
type Row = Record<string, string | number | boolean | undefined> & { id?: string };

/**
 * Weight sits beside the criterion's name, as Fig. 01 captions it ("Functionality × 1"). On a phone
 * that keeps name and weight on one line and gives the judge's question the full width under them.
 */
const FIELDS: RowField[] = [
  { key: "label", label: "Criterion", type: "text", width: "grow basis-32" },
  { key: "weight", label: "Weight", type: "number", width: "w-20" },
  { key: "prompt", label: "Question for the judge", type: "text", width: "basis-full max-lg:pl-7" },
];

/**
 * The rubric's rows under Fig. 01, each criterion's share of a review's total drawn as one bar.
 * The bar starts from the saved weights and follows the weight fields as they are typed, so an
 * organizer sees what 1, 1 and 2 mean before saving; while it differs from what is saved it says so.
 * Before judging a red note says the weights should be right now; once judges have scored
 * (`locked`), a weight change asks for a reason, and the changes made so far are listed, as the
 * published results will show them.
 */
export function RubricEditor({ saved, locked, lockedHint, changes }: { saved: Criterion[]; locked: boolean; lockedHint: string; changes: Change[] }) {
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
  const reweighting = locked && parts.some((p) => saved.some((s) => s.id === p.key && s.weight !== p.weight));
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
      {!locked ? (
        <p className="border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-14 text-flag">
          Check the weights before judges start. Once anyone has scored, a weight change needs a written reason, and the published
          results show it.
        </p>
      ) : null}
      <RowsEditor
        name="rubric"
        initial={saved}
        blank={{ label: "", prompt: "", weight: 1 }}
        addLabel="Add a criterion"
        grid="lg:grid-cols-[20px_minmax(0,11rem)_5rem_minmax(0,1fr)_92px]"
        locked={locked}
        lockedHint={lockedHint}
        fields={FIELDS}
        onRowsChange={onRowsChange}
      />
      {reweighting ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-14 font-medium text-ink">Why the weights change</span>
          <span className="text-13 text-ink-2">Judges have scored already: the published results will show the old and new weights, when, and this reason.</span>
          <Textarea name="reason" required minLength={3} maxLength={500} className="min-h-16" />
        </label>
      ) : null}
      {changes.length ? (
        <div className="flex flex-col gap-1.5 border-t border-rule pt-3 text-13 text-ink-2">
          <span className="label-mono text-ink">Changed after judging began · shown on the published results</span>
          <ul className="flex flex-col gap-1">
            {changes.map((c, i) => (
              <li key={i}>
                <span className="tnum">{formatUtc(c.at)}</span>: {weightMoves(c)}. &ldquo;{c.reason}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
