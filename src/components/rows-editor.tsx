"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SectionErrors } from "@/components/section-form";
import { rowTyped } from "@/lib/row-typed";

export type RowField =
  | { key: string; label: string; type: "text"; placeholder?: string; width?: string }
  | { key: string; label: string; type: "number"; step?: number; width?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; width?: string }
  | { key: string; label: string; type: "checkbox" };

type Row = Record<string, string | number | boolean | undefined> & { id?: string };
/** A row with the key React knows it by: a stored row's id, else one given when the row was made, never its place. */
type Keyed = { k: string; row: Row };

/**
 * An ordered list of small records (tracks, prizes, questions, criteria) that a
 * form submits as one hidden JSON field. Rows keep their ids, so the server can
 * tell a rename from a new row. Each row keeps its own key while it moves or its
 * neighbours go, so the field being typed in and the focused button stay with their row.
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
  grid,
  onRowsChange,
}: {
  name: string;
  initial: Row[];
  fields: RowField[];
  blank: Row;
  addLabel: string;
  locked?: boolean;
  lockedHint?: string;
  disabled?: boolean;
  /**
   * Optional: a literal `lg:grid-cols-[...]` template (number, one column per field, the three
   * buttons). With it the rows read as one ruled table on wide screens: the field labels head
   * the columns once instead of repeating on every row. Narrower, each row keeps its labels.
   */
  grid?: string;
  /** Optional: told the rows after every change, for a live summary beside the editor. */
  onRowsChange?: (rows: Row[]) => void;
}) {
  const made = useRef(0);
  const [items, setItems] = useState<Keyed[]>(() => (initial.length ? initial : [blank]).map((row, i) => ({ k: row.id ?? `new-${i}`, row })));
  const rows = useMemo(() => items.map((it) => it.row), [items]);
  useEffect(() => onRowsChange?.(rows), [rows, onRowsChange]);
  // Keyboard users keep their place: after a move the pressed button stays with its row (or its
  // twin takes over when the row reaches an end); after a remove the next row's Remove takes focus.
  const list = useRef<HTMLOListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<{ k: string; button: "up" | "down" | "remove" } | "add" | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    refocus.current = null;
    if (!want) return;
    if (want === "add") return addButton.current?.focus();
    const li = list.current?.querySelector<HTMLElement>(`li[data-row="${CSS.escape(want.k)}"]`);
    const pick = (b: string) => li?.querySelector<HTMLButtonElement>(`button[data-act="${b}"]`);
    const target = pick(want.button);
    if (target && !target.disabled) target.focus();
    else if (want.button !== "remove") pick(want.button === "up" ? "down" : "up")?.focus();
  }, [items]);
  // a section's refusal names rows by their place in what was sent (the typed rows), see `typed` below
  const errors = useContext(SectionErrors);
  const set = (i: number, key: string, value: Row[string]) =>
    setItems((r) => r.map((it, j) => (j === i ? { ...it, row: { ...it.row, [key]: value } } : it)));
  const focused = (e: React.MouseEvent<HTMLButtonElement>) => document.activeElement === e.currentTarget;
  const move = (e: React.MouseEvent<HTMLButtonElement>, i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    if (focused(e)) refocus.current = { k: items[i]!.k, button: d < 0 ? "up" : "down" };
    setItems((r) => {
      const next = [...r];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };
  const remove = (e: React.MouseEvent<HTMLButtonElement>, i: number) => {
    if (focused(e)) {
      const stay = items[i + 1] ?? items[i - 1];
      refocus.current = stay ? { k: stay.k, button: "remove" } : "add";
    }
    setItems((r) => r.filter((_, j) => j !== i));
  };
  const add = () => {
    made.current += 1;
    setItems((r) => [...r, { k: `added-${made.current}`, row: { ...blank } }]);
  };
  // A new row nobody changed is left out, so the blank row the editor starts with never fails
  // validation ("a prize needs a name"); a stored row, or one with any field changed, is sent.
  const isTyped = (row: Row) => rowTyped(row, fields, blank);
  const typed = rows.filter(isTyped);
  const sentAt = rows.map((row) => (isTyped(row) ? typed.indexOf(row) : -1));
  const rowErrors = (i: number) => (errors && sentAt[i] >= 0 ? (errors[String(sentAt[i])] ?? []) : []);
  const table = grid ? `lg:grid lg:items-center ${grid}` : "";
  // one field (a track's name): the table fits a phone too, so its label heads the column at every width
  const oneCol = Boolean(grid) && fields.length === 1 && fields[0].type !== "checkbox";
  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={JSON.stringify(typed)} />
      {grid ? (
        <div aria-hidden className={`gap-2 px-2.5 text-12 text-ink-3 ${oneCol ? "max-lg:pl-9" : "max-lg:hidden"} ${table}`}>
          <span />
          {fields.map((f) => (
            <span key={f.key}>{f.type === "checkbox" ? "" : f.label}</span>
          ))}
          <span />
        </div>
      ) : null}
      <ol ref={list} className={grid ? "flex flex-col divide-y divide-rule rounded-sm border border-rule max-lg:gap-0" : "flex flex-col gap-2"}>
        {items.map(({ k, row }, i) => (
          <li
            key={k}
            data-row={k}
            data-invalid={rowErrors(i).length ? "" : undefined}
            className={
              grid
                ? `flex flex-wrap ${oneCol ? "items-center" : "items-end"} gap-2 bg-surface px-2.5 py-2 data-[invalid]:bg-flag-bg data-[invalid]:shadow-[inset_3px_0_0_var(--flag-bar)] ${table}`
                : "flex flex-wrap items-end gap-2 rounded-sm border border-rule bg-surface p-2.5"
            }
          >
            <span className={`w-5 shrink-0 text-right font-mono text-12 text-ink-3 ${oneCol ? "" : grid ? "mb-2 lg:mb-0" : "mb-2"}`}>{i + 1}</span>
            {fields.map((f) => {
              const id = `${name}-${i}-${f.key}`;
              if (f.type === "checkbox") {
                return (
                  <label key={f.key} htmlFor={id} className={`mb-2 flex items-center gap-2 text-13 text-ink-2 ${grid ? "lg:mb-0" : ""}`}>
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
                <label key={f.key} htmlFor={id} className={`flex min-w-0 flex-col gap-1 ${oneCol ? "grow basis-0" : (f.width ?? "grow basis-48")} ${grid ? "lg:w-auto" : ""}`}>
                  <span className={`text-12 text-ink-3 ${oneCol ? "sr-only" : grid ? "lg:sr-only" : ""}`}>{f.label}</span>
                  {f.type === "select" ? (
                    <select
                      id={id}
                      value={String(row[f.key] ?? "")}
                      disabled={disabled}
                      onChange={(e) => set(i, f.key, e.target.value)}
                      className="h-8 rounded-sm border border-edge bg-surface px-2 text-14 disabled:bg-sunken disabled:text-ink-2"
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
                      className="h-8 min-w-0 rounded-sm border border-edge bg-surface px-2 text-14 tnum disabled:bg-sunken disabled:text-ink-2"
                    />
                  )}
                </label>
              );
            })}
            <div className={`ml-auto flex shrink-0 gap-1 ${oneCol ? "" : grid ? "mb-0.5 lg:mb-0" : "mb-0.5"}`}>
              <button type="button" data-act="up" onClick={(e) => move(e, i, -1)} disabled={disabled || i === 0} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30" aria-label={`Move row ${i + 1} up`}>
                <ArrowUp className="size-3.5" aria-hidden />
              </button>
              <button type="button" data-act="down" onClick={(e) => move(e, i, 1)} disabled={disabled || i === rows.length - 1} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30" aria-label={`Move row ${i + 1} down`}>
                <ArrowDown className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                data-act="remove"
                onClick={(e) => remove(e, i)}
                disabled={disabled || locked}
                className="inline-flex size-7 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink disabled:opacity-30"
                aria-label={`Remove row ${i + 1}`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
            {rowErrors(i).length ? (
              <p className="basis-full pl-7 text-13 text-flag lg:col-span-full">{rowErrors(i).join("; ")}</p>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3">
        <button
          ref={addButton}
          type="button"
          onClick={add}
          disabled={disabled || locked}
          className={`${grid ? "shrink-0 whitespace-nowrap " : ""}inline-flex h-8 items-center gap-1.5 rounded-sm border border-dashed border-edge px-3 text-13 text-ink-2 hover:bg-raised hover:text-ink disabled:opacity-40`}
        >
          <Plus className="size-3.5" aria-hidden /> {addLabel}
        </button>
        {locked && lockedHint ? <span className="text-12 text-ink-3">{lockedHint}</span> : null}
      </div>
    </div>
  );
}
