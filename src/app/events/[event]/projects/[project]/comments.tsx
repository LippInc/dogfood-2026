"use client";

import { useRef, useState } from "react";
import { FieldError } from "@/components/field";
import { useFormAction } from "@/components/use-form-action";
import { useRescueFocus } from "@/components/use-rescue-focus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { deleteCommentAction, hideCommentAction, postCommentAction, unhideCommentAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

export function CommentForm({ projectId, path }: { projectId: string; path: string }) {
  const [state, form, pending] = useFormAction(postCommentAction, idle);
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="project" value={projectId} />
      <input type="hidden" name="path" value={path} />
      <label htmlFor="comment-body" className="text-14 font-medium">
        Add a comment
      </label>
      <Textarea
        id="comment-body"
        name="body"
        rows={3}
        maxLength={2000}
        className="font-serif text-17 leading-7"
        aria-invalid={state.fieldErrors?.body ? true : undefined}
        aria-describedby={state.fieldErrors?.body ? "comment-body-error" : undefined}
      />
      <FieldError id="comment-body-error" message={state.fieldErrors?.body} />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending}>{pending ? "Posting…" : "Post comment"}</Button>
        {state.message && !state.fieldErrors?.body ? (
          <span role={state.ok ? "status" : "alert"} className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function HideForm({ commentId, path }: { commentId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [state, form, pending] = useFormAction(hideCommentAction, idle);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-13 text-ink-2 underline underline-offset-4 hover:text-ink">
        Hide…
      </button>
    );
  }
  return (
    <form {...form} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="comment" value={commentId} />
      <input type="hidden" name="path" value={path} />
      <Input
        name="reason"
        placeholder="Reason, shown in its place"
        className="w-64"
        aria-label="Reason"
        aria-invalid={state.fieldErrors?.reason ? true : undefined}
        aria-describedby={state.fieldErrors?.reason ? `hide-${commentId}-error` : undefined}
        autoFocus
      />
      <Button size="sm" disabled={pending}>
        Hide
      </Button>
      {state.fieldErrors?.reason ? (
        <FieldError id={`hide-${commentId}-error`} message={state.fieldErrors.reason} />
      ) : state.message && !state.ok ? (
        <span role="alert" className="text-13 text-flag">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

const quiet = "text-13 text-ink-2 underline underline-offset-4 hover:text-ink";

/** The author deletes their own comment: one click asks, the second deletes. */
export function DeleteOwnComment({ commentId, path }: { commentId: string; path: string }) {
  const [asking, setAsking] = useState(false);
  const [state, form, pending] = useFormAction(deleteCommentAction, idle);
  // "Keep" removes the question: focus goes back to Delete
  const opener = useRef<HTMLButtonElement>(null);
  useRescueFocus(() => opener.current, asking);
  if (!asking) {
    return (
      <button ref={opener} type="button" onClick={() => setAsking(true)} className={quiet}>
        Delete
      </button>
    );
  }
  return (
    <form {...form} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <input type="hidden" name="comment" value={commentId} />
      <input type="hidden" name="path" value={path} />
      <span className="text-13 text-ink-2">Delete your comment for good?</span>
      <button disabled={pending} className="text-13 font-medium text-flag underline underline-offset-4">
        {pending ? "Deleting…" : "Yes, delete"}
      </button>
      {/* the question replaces the focused button: focus lands on the safe answer */}
      <button type="button" autoFocus onClick={() => setAsking(false)} className={quiet}>
        Keep
      </button>
      {state.message && !state.ok ? (
        <span role="alert" className="text-13 text-flag">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** An organizer shows a hidden comment again. */
export function UnhideForm({ commentId, path }: { commentId: string; path: string }) {
  const [state, form, pending] = useFormAction(unhideCommentAction, idle);
  return (
    <form {...form} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="comment" value={commentId} />
      <input type="hidden" name="path" value={path} />
      <button disabled={pending} className={quiet}>
        {pending ? "Showing…" : "Unhide"}
      </button>
      {state.message && !state.ok ? (
        <span role="alert" className="text-13 text-flag">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
