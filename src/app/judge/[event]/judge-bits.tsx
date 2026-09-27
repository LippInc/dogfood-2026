"use client";

// Small pieces the scores console and the pairwise Compare screen share.

const LETTERS_KEY = "judge-letter-keys";

// The single-key shortcut switch, kept in localStorage; if storage is blocked the
// choice lasts for this page only.
let lettersInMemory = true;
export const letters = {
  subscribe(change: () => void) {
    window.addEventListener("storage", change);
    window.addEventListener("judge:letters", change);
    return () => {
      window.removeEventListener("storage", change);
      window.removeEventListener("judge:letters", change);
    };
  },
  get(): boolean {
    try {
      const stored = localStorage.getItem(LETTERS_KEY);
      return stored === null ? lettersInMemory : stored !== "off";
    } catch {
      return lettersInMemory;
    }
  },
  set(on: boolean) {
    lettersInMemory = on;
    try {
      localStorage.setItem(LETTERS_KEY, on ? "on" : "off");
    } catch {
      /* storage blocked: memory only */
    }
    window.dispatchEvent(new Event("judge:letters"));
  },
};

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

export function ProjectLink({ label, url }: { label: string; url: string | null }) {
  if (!url) return <span className="text-14 text-ink-3">No {label.toLowerCase()} submitted</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex h-9 max-w-full items-center gap-2 rounded-sm border border-edge px-3 text-14 hover:bg-raised"
    >
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-ink-2">{shortUrl(url)}</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[2px] border border-edge px-1 font-mono text-12 text-ink">{children}</kbd>;
}
