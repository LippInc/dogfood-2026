"use client";

import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { hideCommentAction, postCommentAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

export function CommentForm({ projectId, path }: { projectId: string; path: string }) {
  const [state, action, pending] = useFormAction(postCommentAction, idle);
  return (
    <form {...action} className="flex flex-col gap-3">
      <input type="hidden" name="project" value={projectId} />
      <input type="hidden" name="path" value={path} />
      <label htmlFor="comment-body" className="text-14 font-medium">
        Add a comment
      </label>
      <Textarea id="comment-body" name="body" rows={3} maxLength={2000} className="font-serif text-17 leading-7" aria-invalid={Boolean(state.fieldErrors?.body)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending}>{pending ? "Posting…" : "Post comment"}</Button>
        {state.message ? (
          <span role="status" className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
            {state.fieldErrors?.body?.[0] ?? state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function HideForm({ commentId, path }: { commentId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useFormAction(hideCommentAction, idle);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-13 text-ink-2 underline underline-offset-4 hover:text-ink">
        Hide…
      </button>
    );
  }
  return (
    <form {...action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="comment" value={commentId} />
      <input type="hidden" name="path" value={path} />
      <Input name="reason" placeholder="Reason, shown in its place" className="w-64" aria-label="Reason" autoFocus />
      <Button size="sm" disabled={pending}>
        Hide
      </Button>
      {state.message && !state.ok ? <span className="text-13 text-flag">{state.fieldErrors?.reason?.[0] ?? state.message}</span> : null}
    </form>
  );
}
