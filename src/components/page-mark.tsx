import "server-only";
import { headers } from "next/headers";
import { markPng, PAGE_PATH_HEADER, pageMark, pageSeed, type MarkAnchor } from "@/lib/page-mark";

/** The pixel size of one cell: marks are drawn at whole pixels, so every gap is one pixel wide. */
const PITCH = 4;

/**
 * The page's own mark, drawn on the server from the page's address (src/lib/page-mark.ts).
 * Decorative and fixed in size, so it never moves the layout; the shells place it.
 * `extra` adds to the seed what the address does not carry (a refusal's status, the judge);
 * `lit` keeps the one accent cell, off where a pink square already marks the spot.
 */
export async function PageMark({
  anchor,
  cols,
  rows,
  extra,
  lit = true,
  className = "",
}: {
  anchor: MarkAnchor;
  cols: number;
  rows: number;
  extra?: string;
  lit?: boolean;
  className?: string;
}) {
  const path = (await headers()).get(PAGE_PATH_HEADER);
  const mark = pageMark(pageSeed(path, extra), cols, rows, anchor);
  return (
    <svg
      viewBox={`0 0 ${cols} ${rows}`}
      width={cols * PITCH}
      height={rows * PITCH}
      className={`page-mark block shrink-0 ${className}`}
      data-page-mark={mark.id}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={lit ? mark.d : mark.d + mark.lit} className="fill-face-dot" />
      {lit && mark.lit ? <path d={mark.lit} className="fill-accent" /> : null}
    </svg>
  );
}

/**
 * A long band of the page's mark (the foot of the public pages), drawn as a PNG mask
 * over the edge colour, quieter than the faces' dots, instead of an SVG path, which at
 * this size would weigh tens of kilobytes on every page. No accent cell: the smaller
 * mark in the status strip keeps the page's pink square.
 */
export async function PageBand({ anchor, cols, rows, className = "" }: { anchor: MarkAnchor; cols: number; rows: number; className?: string }) {
  const path = (await headers()).get(PAGE_PATH_HEADER);
  const mark = pageMark(pageSeed(path), cols, rows, anchor);
  const image = `url(data:image/png;base64,${markPng(mark, PITCH)})`;
  return (
    <div
      className={`page-mark shrink-0 bg-edge ${className}`}
      data-page-mark={mark.id}
      aria-hidden="true"
      style={{
        width: cols * PITCH,
        height: rows * PITCH,
        maskImage: image,
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
      }}
    />
  );
}
