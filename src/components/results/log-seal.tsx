import { Face } from "@/components/face";

/**
 * The audit-log anchor as a seal: the entry number, the full hash in four mono
 * lines, and a picture drawn from the hash by the same generator as the project
 * faces, so a changed log would draw a different picture. Server-rendered.
 */
export function LogSeal({ entry, hash, what }: { entry: number; hash: string; what: string }) {
  const lines = hash.match(/.{1,16}/g) ?? [hash];
  return (
    <figure className="flex gap-4 rounded-sm border border-rule bg-surface p-4">
      <div className="w-24 shrink-0 self-start overflow-hidden rounded-xs border border-rule">
        <Face id={`log:${hash}`} cols={32} rows={18} />
      </div>
      <figcaption className="min-w-0">
        <p className="label-mono text-ink">Audit entry #{entry}</p>
        <p className="mt-2 font-mono text-12 leading-4 text-ink-2 break-all" aria-label={`hash ${hash}`}>
          {lines.map((l, i) => (
            <span key={i} className="block">
              {l}
            </span>
          ))}
        </p>
        <p className="mt-2 text-13 text-ink-2">{what}</p>
      </figcaption>
    </figure>
  );
}
