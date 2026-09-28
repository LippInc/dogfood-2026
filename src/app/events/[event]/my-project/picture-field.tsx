"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProjectImage } from "@/components/project-cover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The gallery card's picture: uploaded here (the portal keeps the file) or the address of an image
 * elsewhere. An upload or a take-down saves at once, through the project's image route; the form's
 * Save sends back whichever the field shows, so saving the rest never undoes an upload.
 */
export function PictureField({
  projectId,
  initial,
  error,
  face,
}: {
  projectId: string | null;
  initial: string | null;
  error?: string[];
  /** the project's generated face, drawn on the server: shown while there is no picture, or when one does not load */
  face: React.ReactNode;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const uploaded = url.startsWith("/uploads/");

  async function send(method: "POST" | "DELETE", file?: File) {
    if (!projectId) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/image`, {
        method,
        ...(file ? { body: file, headers: { "content-type": file.type || "application/octet-stream" } } : {}),
      });
      const body = (await res.json().catch(() => null)) as { thumbnailUrl?: string | null; message?: string } | null;
      if (!res.ok) {
        setNote({ ok: false, text: body?.message ?? "That did not work; try again." });
        return;
      }
      setUrl(body?.thumbnailUrl ?? "");
      setNote({ ok: true, text: method === "POST" ? "Uploaded: it is your gallery card's picture now." : "The picture is taken down." });
      router.refresh();
    } catch {
      setNote({ ok: false, text: "The upload did not reach the portal; check the connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  const message = error?.[0];
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      {/* before the first save there is no file input yet: the label names the address box instead */}
      <label htmlFor={projectId ? "picture-file" : "thumbnailUrl"} className="text-14 font-medium">
        Picture
      </label>
      <p id="picture-help" className="text-13 text-ink-3">
        Shown on your gallery card at 16:9. Upload a PNG, JPEG or WebP up to 8 MB, or give the address of an image.
      </p>
      <div className="mt-1 grid gap-4 sm:grid-cols-[208px_minmax(0,1fr)] sm:items-start">
        <div className="overflow-hidden rounded-xs border border-rule">
          {url ? <ProjectImage key={url} src={url} alt="" fallback={face} /> : <div className="opacity-60">{face}</div>}
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          {projectId ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="picture-file"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                aria-describedby="picture-help picture-note"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void send("POST", file);
                }}
                className="max-w-full text-13 text-ink-2 file:mr-3 file:h-10 sm:file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-edge file:bg-surface file:px-3 file:text-13 file:font-medium file:text-ink hover:file:bg-sunken disabled:opacity-60"
              />
              {url ? (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send("DELETE")}>
                  Take it down
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-13 text-ink-2">
              Save the project once, then upload its picture here.
            </p>
          )}
          {uploaded ? (
            // the uploaded file's address, sent back unchanged with the rest of the form
            <input type="hidden" name="thumbnailUrl" value={url} />
          ) : (
            <Input
              id="thumbnailUrl"
              name="thumbnailUrl"
              type="url"
              inputMode="url"
              placeholder="or an image address: https://"
              aria-label="Image address"
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? "thumbnailUrl-error" : undefined}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
          <p id="picture-note" aria-live="polite" className={`min-h-5 text-13 ${note && !note.ok ? "font-medium text-flag" : "text-ink-2"}`}>
            {busy ? "Uploading…" : note?.text}
          </p>
          {message ? (
            <p id="thumbnailUrl-error" className="text-13 font-medium text-flag">
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
