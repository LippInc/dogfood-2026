import { projectFace } from "@/lib/faces";

/** A project's dithered face. Decorative: the title next to it names the project. */
export function Face({
  id,
  cols = 48,
  rows = 27,
  className = "",
}: {
  id: string;
  cols?: number;
  rows?: number;
  className?: string;
}) {
  const face = projectFace(id, cols, rows);
  return (
    <svg
      viewBox={`0 0 ${face.cols} ${face.rows}`}
      className={`face ${className}`}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="none"
    >
      <rect className="face-bg" width={face.cols} height={face.rows} />
      <path className="face-dots" d={face.d} />
    </svg>
  );
}
