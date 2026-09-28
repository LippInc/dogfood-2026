"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { DitherDigits } from "@/components/dither-digits";
import { PlainFrame } from "@/components/shell/plain-frame";
import { buttonVariants } from "@/components/ui/button";

const noSubscription = () => () => {};

/**
 * The address the browser asked for, read after hydration only: the server may have drawn
 * this page ahead of time, so its idea of the path is not the reader's.
 */
export function useAskedPath(): string | null {
  return useSyncExternalStore(noSubscription, () => window.location.pathname, () => null);
}

/** The asked-for path as text; "this address" until the browser has said which. */
export function AskedPath() {
  const path = useAskedPath();
  return <>{path ?? "this address"}</>;
}

export type SheetRow ={ label: string; value: React.ReactNode; mono?: boolean };

/**
 * The status drawn as a sheet: the number in the faces' dither inside corner marks, and a
 * title block under it that shows the working (what was asked for, what came back).
 */
function StatusSheetFigure({ status, rows, spoil }: { status: string; rows: SheetRow[]; spoil?: React.ComponentProps<typeof DitherDigits>["spoil"] }) {
  return (
    <figure className="corner-marks rounded-xs border border-rule p-6 sm:p-8">
      <div className="overflow-hidden rounded-xs border border-rule" aria-hidden="true">
        <DitherDigits value={status} spoil={spoil} />
      </div>
      <figcaption className="mt-5">
        <p className="label-mono border-b-2 border-ink pb-2 text-ink">Fig. {status}</p>
        <dl className="text-14">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 border-b border-rule py-2.5 last:border-b-0">
              <dt className="label-mono pt-0.5 text-ink-3">{r.label}</dt>
              <dd className={r.mono ? "font-mono text-13 break-all text-ink" : "text-ink-2"}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  );
}

export type NextStep = { href: string; head: string; body: string };

/**
 * The page for a status the reader did not want (the site-wide 404 and 500): what happened
 * in words, the one way on, then the status as a figure with its working.
 */
export function StatusSheet({
  code,
  title,
  lead,
  status,
  spoil,
  rows,
  actions,
  steps = [],
  stepsTitle = "Or go to",
  mark,
  band,
}: {
  code: string;
  title: string;
  lead: React.ReactNode;
  status: string;
  spoil?: React.ComponentProps<typeof DitherDigits>["spoil"];
  rows: SheetRow[];
  actions: React.ReactNode;
  steps?: NextStep[];
  stepsTitle?: string;
  /** The page's mark, from a server page (PlainMark); the error boundary runs in the browser and has none. */
  mark?: React.ReactNode;
  /** Its band along the foot, from the same server page (PlainBand). */
  band?: React.ReactNode;
}) {
  return (
    <PlainFrame width="max-w-[1120px]" mark={mark} band={band}>
      <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-20">
        <div className="md:pt-6">
          <p className="label-mono text-accent-ink">{code}</p>
          <h1 className="mt-3 font-display text-38">{title}</h1>
          <div className="mt-4 max-w-[600px] space-y-3 text-17 text-ink-2">{lead}</div>
          <div className="mt-8 flex flex-wrap gap-3">{actions}</div>
          {steps.length ? (
            <nav aria-labelledby="status-steps" className="mt-14 max-w-[600px]">
              <h2 id="status-steps" className="label-mono text-ink-3">
                {stepsTitle}
              </h2>
              <ol className="mt-4 grid gap-6 sm:grid-cols-2">
                {steps.map((s, i) => (
                  <li key={s.href} className="border-t-2 border-ink pt-3">
                    <Link href={s.href} className="group grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 rounded-xs">
                      <span className="label-mono pt-0.5 text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                      <span className="flex flex-col gap-1">
                        <span className="text-15 font-semibold underline decoration-transparent underline-offset-4 group-hover:decoration-ink">
                          {s.head}
                        </span>
                        <span className="text-14 text-ink-2">{s.body}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
        </div>
        <div className="max-md:max-w-[440px]">
          <StatusSheetFigure status={status} rows={rows} spoil={spoil} />
        </div>
      </div>
    </PlainFrame>
  );
}

/** A value with a Copy button beside it, for the log id an operator searches for. */
export function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <code className="font-mono text-13 break-all text-ink">{value}</code>
      <button
        type="button"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
