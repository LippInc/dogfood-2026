"use client";

import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { addTag, cleanTag, joinTags, removeTag, suggestTags, TAG_LIMIT, tagKey, tagProblem } from "@/lib/tags";

/**
 * The tech-tag picker: type to filter the list (the tags other projects of the event carry first, then the common
 * ones in src/lib/tags.ts), pick with a click or Enter, or add your own. The picked tags show as chips, each with its
 * own remove button; Backspace in the empty box removes the last one. The form sends one hidden value, the chips
 * joined by ", ", which the save action splits on commas as it always has.
 *
 * The WAI-ARIA combobox pattern: the text box is the combobox, the list a listbox, and the highlighted option is
 * named by aria-activedescendant, so focus stays in the box while the arrows move through the list.
 */
export function TagPicker({
  id,
  name,
  initial,
  eventTags,
  onChange,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  /** the text box's id, which the field's label points at */
  id: string;
  /** the hidden value's name, as the save action reads it */
  name: string;
  initial: string[];
  /** tags the event's gallery already shows, the most carried first */
  eventTags: string[];
  /** called with the chips after every change (the hidden value moves without an input event) */
  onChange?: (tags: string[]) => void;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>(() => initial.reduce<string[]>((acc, t) => addTag(acc, t), []));
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [note, setNote] = useState<{ text: string; problem: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const countId = `${uid}-count`;
  const full = picked.length >= TAG_LIMIT;
  const options = useMemo(() => (full ? [] : suggestTags(text, picked, eventTags)), [full, text, picked, eventTags]);
  const shown = open && options.length > 0;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // the highlighted option stays in view while the arrows move through a long list
  useEffect(() => {
    if (!shown || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, shown]);

  const commit = (next: string[], said: string) => {
    setPicked(next);
    setNote({ text: said, problem: false });
    onChange?.(next);
  };

  const pick = (label: string) => {
    const problem = tagProblem(label, picked);
    if (problem) {
      setNote({ text: problem, problem: true });
      return;
    }
    const next = addTag(picked, label);
    if (next.length === picked.length) return;
    setText("");
    setActive(-1);
    commit(next, `Added ${cleanTag(label)}.`);
    if (next.length >= TAG_LIMIT) setOpen(false);
  };

  const drop = (tag: string, refocus: boolean) => {
    const next = removeTag(picked, tag);
    commit(next, `Removed ${tag}.`);
    if (refocus) input.current?.focus();
  };

  // Typing highlights the first suggestion when it starts with the text, so Enter takes "React" for "reac"; the
  // typed text itself is the last option ("Add “reac”"), reached with the arrows or taken when nothing starts with it.
  const typed = (value: string) => {
    setText(value);
    setOpen(true);
    const q = cleanTag(value).toLowerCase();
    const next = full ? [] : suggestTags(value, picked, eventTags);
    setActive(q && next[0] && next[0].source !== "custom" && next[0].label.toLowerCase().startsWith(q) ? 0 : -1);
    setNote(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      if (!shown) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : options.length - 1);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a < 0 ? (step > 0 ? 0 : options.length - 1) : (a + step + options.length) % options.length));
    } else if (e.key === "Home" && shown && active >= 0) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && shown && active >= 0) {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter") {
      // Enter picks here; it never sends the form from this box
      e.preventDefault();
      if (full && cleanTag(text)) {
        setNote({ text: tagProblem(text, picked) ?? "", problem: true });
      } else if (shown && active >= 0 && options[active]) {
        pick(options[active].label);
      } else if (cleanTag(text)) {
        const same = options.find((o) => tagKey(o.label) === tagKey(text));
        pick(same ? same.label : text);
      }
    } else if (e.key === "Escape") {
      if (shown) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
      } else if (text) {
        e.preventDefault();
        e.stopPropagation();
        setText("");
        setNote(null);
      }
    } else if (e.key === "Backspace" && !text && picked.length) {
      e.preventDefault();
      drop(picked[picked.length - 1]!, false);
    } else if (e.key === "Tab") {
      setOpen(false);
      setActive(-1);
    }
  };

  const status = note?.text ?? "";
  const count = `${picked.length} of ${TAG_LIMIT}`;

  return (
    <div className="relative">
      <div
        className={`flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-sm border bg-surface px-1.5 py-[5px] has-[[role=combobox]:focus-visible]:outline-2 has-[[role=combobox]:focus-visible]:outline-offset-2 has-[[role=combobox]:focus-visible]:outline-focus has-[[role=combobox]:disabled]:bg-sunken ${
          invalid ? "border-edge border-l-[3px] border-l-flag-bar" : "border-edge"
        }`}
        onClick={(e) => {
          if (e.target === e.currentTarget) input.current?.focus();
        }}
      >
        {picked.length ? (
          <ul aria-label="Picked tags" className="contents">
            {picked.map((t) => (
              <li key={tagKey(t)} className="inline-flex h-7 max-w-full items-center rounded-xs border border-rule bg-raised pl-2 font-mono text-13 text-ink">
                <span className="min-w-0 truncate">{t}</span>
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => drop(t, true)}
                  className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-xs text-ink-3 hover:bg-sunken hover:text-ink disabled:hover:bg-transparent"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
          aria-describedby={[describedBy, countId].filter(Boolean).join(" ")}
          aria-invalid={invalid}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={80}
          value={text}
          placeholder={full ? `${TAG_LIMIT} of ${TAG_LIMIT}: remove one to add another` : picked.length ? "Add a tag" : "Type to find a tag, e.g. Rust"}
          onChange={(e) => typed(e.target.value)}
          onKeyDown={onKeyDown}
          onClick={() => {
            if (!full) setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          className="h-7 min-w-[10ch] flex-1 bg-transparent px-1.5 text-15 text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
      </div>
      <input type="hidden" name={name} value={joinTags(picked)} />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Tech tags"
        hidden={!shown}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-sm border border-rule bg-surface p-1 text-ink shadow-overlay"
      >
        {shown
          ? options.map((o, i) => (
              <li
                key={`${o.source}:${tagKey(o.label)}`}
                id={optionId(i)}
                data-index={i}
                role="option"
                aria-selected={i === active}
                // the box keeps focus: a click picks without a blur closing the list first
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.label)}
                onMouseMove={() => {
                  if (active !== i) setActive(i);
                }}
                className="flex min-h-9 cursor-default items-center justify-between gap-3 rounded-xs px-2 py-1.5 text-15 aria-selected:bg-raised"
              >
                <span className="min-w-0 wrap-anywhere">{o.source === "custom" ? `Add “${o.label}”` : o.label}</span>
                {o.source === "event" ? <span className="shrink-0 text-12 text-ink-3">in this event</span> : null}
              </li>
            ))
          : null}
      </ul>
      <p className="mt-1.5 flex justify-between gap-3 text-13">
        <span id={statusId} role="status" aria-live="polite" className={`min-w-0 ${note?.problem ? "font-medium text-flag" : "text-ink-3"}`}>
          {status}
          {note && !note.problem ? <span className="sr-only"> {count} tags.</span> : null}
        </span>
        <span id={countId} className={`shrink-0 tnum ${full ? "font-medium text-ink-2" : "text-ink-3"}`}>
          {count}
          <span className="sr-only"> tags picked{full ? ", the most a project carries" : ""}</span>
        </span>
      </p>
    </div>
  );
}
