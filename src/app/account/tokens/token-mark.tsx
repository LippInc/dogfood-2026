/**
 * A token's mark: the characters of its hint after the "dfk_" prefix, drawn bit by bit.
 * One row per character, its six bits as base64url (A = 000000 ... 9 = 111101) from left
 * to right, a square filled for each 1. Nothing is hashed or invented: it is the hint the
 * row already prints, as a picture, so two tokens are told apart at a glance and a token
 * just made can be matched to its row. Pure, so the server rows and the client plate draw
 * the same mark. Decorative: the hint beside it says the same in text.
 */
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function markChars(hint: string): string {
  return hint.slice(hint.indexOf("_") + 1);
}

export function TokenMark({ hint, lit = false, dim = false, className = "" }: { hint: string; lit?: boolean; dim?: boolean; className?: string }) {
  const chars = [...markChars(hint)];
  const rows = Math.max(chars.length, 1);
  let d = "";
  chars.forEach((ch, y) => {
    const v = B64URL.indexOf(ch);
    if (v < 0) return;
    for (let x = 0; x < 6; x++) if ((v >> (5 - x)) & 1) d += `M${x} ${y}h1v1h-1z`;
  });
  return (
    <svg
      viewBox={`-1 -1 8 ${rows + 2}`}
      className={`block shrink-0 ${className}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={-1} y={-1} width={8} height={rows + 2} className="fill-face-bg" />
      {d ? <path d={d} className={lit ? "fill-accent" : dim ? "fill-face-dot opacity-45" : "fill-face-dot"} /> : null}
    </svg>
  );
}
