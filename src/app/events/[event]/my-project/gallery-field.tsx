"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useRef, useState } from "react";
import { ProjectImage } from "@/components/project-cover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The gallery's size: the server holds to the same (MAX_GALLERY_IMAGES in src/server/project-limits.ts). */
const MAX = 6;

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
};

/**
 * The project page's image gallery: up to six images in the order the page shows them, each uploaded here (the
 * portal keeps the file, drawn again without its metadata) or the address of an image elsewhere. Once the project is
 * saved, every change (an upload, a link added, a move, a removal) saves at once through the gallery's route, which
 * answers the list as stored; the form's Save sends that list back, so saving the rest never undoes a change. Before
 * the first save there is nowhere to upload to yet: links are kept here and saved with the project.
 */
export function GalleryField({
  projectId,
  initial,
  error,
  required = false,
  onChange,
}: {
  projectId: string | null;
  initial: string[];
  error?: string[];
  /** the organizers ask for gallery images before a team can submit */
  required?: boolean;
  /** told after a change, which moves no typed input the form's checklist listens to */
  onChange?: () => void;
}) {
  const [list, setList] = useState<string[]>(initial);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const full = list.length >= MAX;

  /** After the list redraws, put focus where the person's next step is: the moved image's button, or the next control. */
  function focusLater(selector: string, fallback: string) {
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(selector);
      (el && !(el as HTMLButtonElement).disabled ? el : root.current?.querySelector<HTMLElement>(fallback))?.focus();
    });
  }

  function adopt(next: string[], text: string) {
    setList(next);
    setNote({ ok: true, text });
    onChange?.();
  }

  /** Save a new list: at once through the route once the project exists, else only here until the project's first save. */
  async function commit(next: string[], text: string): Promise<boolean> {
    if (!projectId) {
      adopt(next, text);
      return true;
    }
    setBusy("Saving…");
    setNote(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/gallery`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ galleryUrls: next, expected: list }),
      });
      const body = (await res.json().catch(() => null)) as { galleryUrls?: string[]; message?: string; details?: { galleryUrls?: string[] } } | null;
      if (!res.ok) {
        setNote({ ok: false, text: body?.details?.galleryUrls?.[0] ? `That address ${body.details.galleryUrls[0]}.` : (body?.message ?? "That did not work; try again.") });
        return false;
      }
      adopt(body?.galleryUrls ?? next, text);
      return true;
    } catch {
      setNote({ ok: false, text: "The change did not reach the portal; check the connection and try again." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function upload(files: File[]) {
    if (!projectId || !files.length) return;
    const room = MAX - list.length;
    const sending = files.slice(0, room);
    setNote(null);
    let current = list;
    try {
      for (const [n, file] of sending.entries()) {
        setBusy(sending.length > 1 ? `Uploading ${n + 1} of ${sending.length}…` : "Uploading…");
        const res = await fetch(`/api/projects/${projectId}/gallery`, {
          method: "POST",
          body: file,
          headers: { "content-type": file.type || "application/octet-stream" },
        });
        const body = (await res.json().catch(() => null)) as { galleryUrls?: string[]; message?: string } | null;
        if (!res.ok) {
          setNote({ ok: false, text: `${sending.length > 1 ? `${file.name}: ` : ""}${body?.message ?? "That did not work; try again."}` });
          return;
        }
        current = body?.galleryUrls ?? current;
        setList(current);
        onChange?.();
      }
      const skipped = files.length - sending.length;
      setNote({
        ok: true,
        text: `${sending.length === 1 ? "Uploaded: it is on your project page now." : `Uploaded ${sending.length} images: they are on your project page now.`}${skipped ? ` ${skipped} more did not fit: the gallery holds ${MAX}.` : ""}`,
      });
    } catch {
      setNote({ ok: false, text: "The upload did not reach the portal; check the connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  async function addLink() {
    const url = link.trim();
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      setNote({ ok: false, text: "An image address starts with https:// (or http://)." });
      return;
    }
    if (list.includes(url)) {
      setNote({ ok: false, text: "That image is in the gallery already." });
      return;
    }
    if (await commit([...list, url], "Added: it is on your project page now.")) setLink("");
  }

  async function move(i: number, by: -1 | 1) {
    const next = [...list];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    if (await commit(next, `Moved to place ${i + by + 1} of ${next.length}.`)) {
      const n = i + by;
      focusLater(`[data-gallery-item="${n}"] [data-move="${by < 0 ? "up" : "down"}"]`, `[data-gallery-item="${n}"] [data-move="${by < 0 ? "down" : "up"}"]`);
    }
  }

  async function remove(i: number) {
    const next = list.filter((_, n) => n !== i);
    if (await commit(next, "Removed from the gallery.")) {
      focusLater(`[data-gallery-item="${Math.min(i, next.length - 1)}"] [data-remove]`, "#gallery-file, #gallery-link");
    }
  }

  const message = error?.[0];
  const disabled = busy !== null;
  return (
    // id galleryUrls: a refused save moves focus to the field it names; the group takes it (form.elements never lists a div,
    // so the checklist still reads the hidden list by its name)
    <div ref={root} id="galleryUrls" tabIndex={-1} role="group" aria-labelledby="gallery-label" className="flex flex-col gap-1.5 outline-none">
      <label id="gallery-label" htmlFor={full ? undefined : projectId ? "gallery-file" : "gallery-link"} className="text-14 font-medium">
        Image gallery
        {required ? <span className="text-ink-3"> · required</span> : null}
      </label>
      <p id="gallery-help" className="text-13 text-ink-3">
        Up to {MAX} images, shown on your project page in this order. Upload PNG, JPEG or WebP up to 8 MB each, or add the address of an image.
      </p>
      {/* the list as the form's Save sends it back: one address per line */}
      <input type="hidden" name="galleryUrls" value={list.join("\n")} />
      {list.length ? (
        <ol aria-label="Gallery images, in the order the project page shows them" className="mt-1 grid gap-2.5 sm:grid-cols-2">
          {list.map((url, i) => {
            const uploaded = url.startsWith("/uploads/");
            return (
              <li key={url} data-gallery-item={i} className="flex min-w-0 items-center gap-3 rounded-xs border border-rule p-2">
                <div className="w-24 shrink-0 overflow-hidden rounded-xs border border-rule sm:w-28">
                  <ProjectImage
                    src={url}
                    alt=""
                    fallback={<div className="flex aspect-video w-full items-center justify-center bg-sunken px-1 text-center text-12 text-ink-3">Did not load</div>}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-12 text-ink-3 tnum">{String(i + 1).padStart(2, "0")}</p>
                  <p className="truncate text-13 text-ink-2" title={uploaded ? undefined : url}>
                    {uploaded ? "Uploaded" : hostOf(url)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 sm:size-8"
                    data-move="up"
                    aria-label={`Move image ${i + 1} earlier`}
                    disabled={disabled || i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 sm:size-8"
                    data-move="down"
                    aria-label={`Move image ${i + 1} later`}
                    disabled={disabled || i === list.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 sm:size-8"
                    data-remove
                    aria-label={`Remove image ${i + 1}`}
                    disabled={disabled}
                    onClick={() => void remove(i)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      <div className="mt-1 flex flex-col gap-2.5">
        {full ? (
          <p className="text-13 text-ink-2">The gallery holds {MAX} images, as many as it can. Remove one to add another.</p>
        ) : (
          <>
            {projectId ? (
              <input
                id="gallery-file"
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp"
                disabled={disabled}
                aria-describedby="gallery-help gallery-note"
                onChange={(e) => {
                  const files = [...(e.currentTarget.files ?? [])];
                  e.currentTarget.value = "";
                  void upload(files);
                }}
                className="max-w-full text-13 text-ink-2 file:mr-3 file:h-10 sm:file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-edge file:bg-surface file:px-3 file:text-13 file:font-medium file:text-ink hover:file:bg-sunken disabled:opacity-60"
              />
            ) : (
              <p className="text-13 text-ink-2">Save the project once, then upload images here. Image addresses can be added now.</p>
            )}
            <div className="flex gap-2">
              <Input
                id="gallery-link"
                type="url"
                inputMode="url"
                placeholder="or an image address: https://"
                aria-label="Image address to add to the gallery"
                aria-invalid={message ? true : undefined}
                aria-describedby={message ? "galleryUrls-error" : undefined}
                value={link}
                disabled={disabled}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  // Enter adds the address; it never submits the whole form
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addLink();
                  }
                }}
                className="min-w-0 flex-1"
              />
              <Button type="button" variant="outline" disabled={disabled || !link.trim()} onClick={() => void addLink()}>
                Add
              </Button>
            </div>
          </>
        )}
        <p id="gallery-note" aria-live="polite" className={`min-h-5 text-13 ${note && !note.ok ? "font-medium text-flag" : "text-ink-2"}`}>
          {busy ?? note?.text}
        </p>
        {message ? (
          <p id="galleryUrls-error" className="text-13 font-medium text-flag">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
