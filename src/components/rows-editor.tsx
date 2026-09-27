"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

export type RowField =
  | { key: string; label: string; type: "text"; placeholder?: string; width?: string }
  | { key: string; label: string; type: "number"; step?: number; width?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; width?: string }
  | { key: string; label: string; type: "checkbox" };

type Row = Record<string, string | number | boolean | undefined> & { id?: string };

/**
 * An ordered list of small records (tracks, prizes, questions, criteria) that a
 * form submits as one hidden JSON field. Rows keep their ids, so the server can
 * tell a rename from a new row.
 */
export function RowsEditor({
  name,
  initial,
  fields,
  blank,
  addLabel,
  locked = false,
  lockedHint,
  disabled = false,
}: {
  name: string;
  initial: Row[];
  fields: RowField[];
  blank: Row;
  addLabel: string;
  locked?: boolean;
  lockedHint?: string;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(initial.length ? initial : [blank]);
  const set = (i: number, key: string, value: Row[string]) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: value } : row)));
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const next = [...r];
      const j = i + d;
      if (j < 0 || j >= next.length) return r;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  // A new row nobody typed into is left out, so the blank row the editor starts with
  // never fails validation ("a prize needs a name"); a stored row is always sent.
  const typed = rows.filter((row) => row.id !== undefined || fields.some((f) => f.type === "text" && String(row[f.key] ?? "").trim() !== ""));
  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={JSON.stringify(typed)} />
      <ol className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <li key={row.id ?? `new-${i}`} className="flex flex-wrap items-end gap-2 rounded-sm border border-rule bg-surface p-2.5">
            <span className="mb-2 w-5 shrink-0 text-right font-mono text-12 text-ink-3">{i + 1}</span>
            {fields.map((f) => {
              const id = `${name}-${i}-${f.key}`;
              if (f.type === "checkbox") {
                return (
                  <label key={f.key} htmlFor={id} className="mb-2 flex items-center gap-2 text-13 text-ink-2">
                    <input
                      id={id}
                      type="checkbox"
                      checked={Boolean(row[f.key])}
                      disabled={disabled}
                      onChange={(e) => set(i, f.key, e.target.checked)}
                      className="size-4 accent-[var(--primary)]"
                    />
                    {f.label}
                  </label>
                );
              }
              return (
                <label key={f.key} htmlFor={id} className={`flex min-w-0 flex-col gap-1 ${f.width ?? "flex-1"}`}>
                  <span className="text-12 text-ink-3">{f.label}</span>
                  {f.type === "select" ? (
                    <select
                      id={id}
                      value={String(row[f.key] ?? "")}
                      disabled={disabled}
                      onChange={(e) => set(i, f.key, e.target.value)}
                      className="h-8 rounded-sm border border-edge bg-surface px-2 text-14"
                    >
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      type={f.type}
                      step={f.type === "number" ? (f.step ?? 0.5) : undefined}
                      min={f.type === "number" ? 0 : undefined}
                      value={String(row[f.key] ?? "")}
                      placeholder={f.type === "text" ? f.placeholder : undefined}
                      disabled={disabled}
                      onChange={(e) => set(i, f.key, f.type === "number" ? e.target.value : e.target.value)}
                      className="h-8 min-w-0 rounded-sm border border-edge bg-surface px-2 text-14 tnum"
                    />
                  )}
                </label>
              );
            })}
            <div className="mb-0.5 ml-auto flex shrink-0 gap-1">
              <button type="button" onClick={() => move(i, -1)} disabled={disabled || i === 0} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30" aria-label={`Move row ${i + 1} up`}>
                <ArrowUp className="size-3.5" aria-hidden />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={disabled || i === rows.length - 1} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30" aria-label={`Move row ${i + 1} down`}>
                <ArrowDown className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
                disabled={disabled || locked}
                className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30"
                aria-label={`Remove row ${i + 1}`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setRows((r) => [...r, { ...blank }])}
          disabled={disabled || locked}
          className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-dashed border-edge px-3 text-13 text-ink-2 hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <Plus className="size-3.5" aria-hidden /> {addLabel}
        </button>
        {locked && lockedHint ? <span className="text-12 text-ink-3">{lockedHint}</span> : null}
      </div>
    </div>
  );
}
