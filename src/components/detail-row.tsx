"use client";

import { ChevronRight } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";

/**
 * A table row whose details open in a row of their own below it, across the whole table.
 *
 * A <details> inside a cell widens its column when it opens, and every column beside it
 * slides sideways (up to 464 px on the results table): here the details get the table's
 * full width instead, so opening them only pushes the rows below down and moves nothing
 * sideways. The row itself and the details are drawn on the server and passed in; the
 * toggle, a real button with aria-expanded, goes anywhere inside the row.
 */
const Row = createContext<{ open: boolean; toggle: () => void; id: string } | null>(null);

export function DetailRows({
  children,
  detail,
  colSpan,
  detailRowClassName = "",
  detailCellClassName = "",
}: {
  /** The row itself (a <tr>), with a <DetailToggle> somewhere inside it. */
  children: React.ReactNode;
  /** What opens below it. */
  detail: React.ReactNode;
  /** Every column of the table, so the details span it. */
  colSpan: number;
  detailRowClassName?: string;
  detailCellClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Row.Provider value={{ open, toggle: () => setOpen((o) => !o), id }}>
      {children}
      <tr id={id} hidden={!open} className={detailRowClassName}>
        <td colSpan={colSpan} className={detailCellClassName}>
          {detail}
        </td>
      </tr>
    </Row.Provider>
  );
}

/**
 * The button that opens and closes its row's details; a chevron turns to show which, at once: a row can hold two
 * toggles (the judges table's name and tracks), and an animated turn made the other one twitch as the row opened.
 */
export function DetailToggle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const row = useContext(Row);
  if (!row) throw new Error("DetailToggle belongs inside DetailRows");
  return (
    <button
      type="button"
      aria-expanded={row.open}
      aria-controls={row.id}
      onClick={row.toggle}
      className={`group/toggle inline-flex min-h-6 cursor-pointer items-start gap-1 text-left ${className}`}
    >
      <ChevronRight
        className="mt-[3px] size-3.5 shrink-0 text-ink-3 group-aria-expanded/toggle:rotate-90"
        aria-hidden
      />
      <span className="min-w-0">{children}</span>
    </button>
  );
}
