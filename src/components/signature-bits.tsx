/**
 * A signature drawn bit by bit: every bit of the base64url signature is one square
 * (an Ed25519 signature is 64 bytes, so 512 squares, 32 by 16), filled when the bit
 * is 1. Nothing is hashed or invented: change one bit of the signature and one square
 * changes. Works on the server and in the browser (atob exists in both).
 */
export function bitsOf(signature: string): number[] | null {
  try {
    const b64 = signature.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((signature.length + 3) % 4);
    const bin = atob(b64);
    const bits: number[] = [];
    for (let i = 0; i < bin.length; i++) {
      const byte = bin.charCodeAt(i);
      for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
    }
    return bits;
  } catch {
    return null;
  }
}

/**
 * `against`, when given, is the signature this one should have been: every bit that differs
 * from it is drawn in the alarm colour, whether it is set or not. Without it nothing changes.
 */
export function SignatureBits({
  signature,
  cols = 32,
  className = "",
  lit = false,
  against,
}: {
  signature: string;
  cols?: number;
  className?: string;
  lit?: boolean;
  against?: string;
}) {
  const bits = bitsOf(signature);
  if (!bits || bits.length === 0) return null;
  const other = against ? bitsOf(against) : null;
  const rows = Math.ceil(bits.length / cols);
  let d = "";
  let differ = "";
  bits.forEach((bit, i) => {
    const square = `M${i % cols} ${Math.floor(i / cols)}h1v1h-1z`;
    if (other && other[i] !== bit) differ += square;
    else if (bit) d += square;
  });
  return (
    <svg
      viewBox={`-1 -1 ${cols + 2} ${rows + 2}`}
      className={`sig-bits block h-auto w-full ${className}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={-1} y={-1} width={cols + 2} height={rows + 2} className="fill-face-bg" />
      <path d={d} className={lit ? "fill-accent" : "fill-face-dot"} />
      {differ ? <path d={differ} className="fill-flag-bar" data-differ="" /> : null}
    </svg>
  );
}
