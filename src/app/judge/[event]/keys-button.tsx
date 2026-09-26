"use client";

/** Opens the console's key list; the console listens for the event. */
export function KeysButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("judge:keys"))}
      className="inline-flex h-8 items-center gap-2 rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised"
    >
      Keys
      <kbd className="rounded-[2px] border border-edge px-1 font-mono text-12">?</kbd>
    </button>
  );
}
