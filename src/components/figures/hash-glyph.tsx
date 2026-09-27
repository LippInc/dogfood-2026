// A hash drawn as its own bits: each hex digit becomes one column of four cells,
// read top to bottom as 8, 4, 2, 1. The picture is the hash itself, not a
// decoration made from it, so two rows with different hashes can never look alike
// and a changed row changes its glyph. Server-rendered SVG, fills from the tokens.

export function HashGlyph({
  hash,
  digits = 8,
  groupEvery = 0,
  className = "",
}: {
  hash: string;
  /** how many leading hex digits to draw; 64 draws the whole SHA-256 */
  digits?: number;
  /** leave a one-cell gap after every this many digits (0: none), to match a grouped reading of the hash */
  groupEvery?: number;
  className?: string;
}) {
  const hex = hash.slice(0, digits).toLowerCase();
  const col = (x: number) => x * 4 + (groupEvery ? Math.floor(x / groupEvery) * 4 : 0);
  let ones = "";
  let zeros = "";
  [...hex].forEach((ch, x) => {
    const v = Number.parseInt(ch, 16) || 0;
    for (let b = 0; b < 4; b++) {
      const cell = `M${col(x)} ${b * 4}h3v3h-3z`;
      if (v & (8 >> b)) ones += cell;
      else zeros += cell;
    }
  });
  const w = col(hex.length - 1) + 3;
  return (
    <svg
      viewBox={`0 0 ${w} 15`}
      width={w}
      height={15}
      className={`hash-glyph ${className}`}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      <path className="hash-glyph-zeros" d={zeros} />
      <path className="hash-glyph-ones" d={ones} />
    </svg>
  );
}

/** "9637c000860…" -> ["9637c000", "86069b72", …]: groups of eight, for reading a hash aloud. */
export function hashGroups(hash: string): string[] {
  return hash.match(/.{1,8}/g) ?? [hash];
}
