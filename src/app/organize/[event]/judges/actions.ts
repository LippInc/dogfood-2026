"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  assignByHand,
  currentActor,
  inviteJudge,
  inviteJudges,
  mailJudgeInvite,
  mailJudgeInvites,
  remindJudges,
  removeJudge,
  revokeJudgeInvite,
  runAssignment,
  setJudgeTracks,
  RateLimitedError,
  type ActionResult,
} from "@/server/dal";
import { mailedNote, mailNote } from "@/lib/mail-note";
import { replacedNote } from "@/lib/invite-note";

export type InviteResult = ActionResult & { path?: string };
export type BatchInviteResult = ActionResult & {
  links?: { name: string; email: string | null; path: string }[];
  skipped?: { line: number; email: string; reason: string }[];
};
export type RunResult = ActionResult & { added?: number; seed?: number; underReviewed?: number };

function refresh(slug: string) {
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/judge/${slug}`);
}

export async function inviteJudgeAction(_prev: InviteResult, form: FormData): Promise<InviteResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    const invite = inviteJudge(actor, slug, {
      name: form.get("name") ?? "",
      email: form.get("email") ?? "",
      trackIds: form.getAll("trackIds").map(String),
    });
    refresh(slug);
    const note = mailNote(await mailJudgeInvite(actor, slug, invite));
    const replaced = invite.replaced && invite.email ? replacedNote([invite.email]) : null;
    return { ok: true, message: `${note ? `${note} ` : ""}Invitation ready. Copy the link now: it is shown only once.${replaced ? ` ${replaced}` : ""}`, path: invite.path };
  } catch (err) {
    return actionError(err);
  }
}

export async function revokeInviteAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    revokeJudgeInvite(actor, String(form.get("invite") ?? ""));
  } catch (err) {
    // no refresh: the row keeps its button and shows why (an invitation accepted meanwhile would
    // otherwise just turn into "accepted", its Revoke and the refusal gone with it)
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: null };
}

export async function setTracksAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    setJudgeTracks(actor, slug, String(form.get("judge") ?? ""), { trackIds: form.getAll("trackIds").map(String) });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: "Tracks saved. Open reviews outside the new tracks leave this judge's list; the next top-up gives those projects another judge." };
}

export async function runAssignmentAction(_prev: RunResult, form: FormData): Promise<RunResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  const seed = String(form.get("seed") ?? "").trim();
  try {
    const run = runAssignment(actor, slug, {
      mode: form.get("mode"),
      ...(seed ? { seed } : {}),
      reviewsPerProject: form.get("reviewsPerProject") || undefined,
      bridgePerTrack: form.get("bridgePerTrack") || undefined,
    });
    refresh(slug);
    const flagged = run.underReviewed.length;
    return {
      ok: true,
      added: run.added,
      seed: run.seed,
      underReviewed: flagged,
      message: `${run.added === 0 ? "Nothing to add" : `${run.added} ${run.added === 1 ? "review" : "reviews"} assigned`} (seed ${run.seed}).${
        flagged ? ` ${flagged} under-reviewed ${flagged === 1 ? "project needs" : "projects need"} a judge by hand.` : ""
      }`,
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function assignByHandAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    assignByHand(actor, slug, {
      projectId: form.get("project"),
      judgeUserId: form.get("judge"),
      reason: form.get("reason") ?? "",
    });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: "Assigned. The judge sees it at the end of their batch." };
}

export async function removeJudgeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  let out: { withdrawn: number; voided: boolean };
  try {
    out = removeJudge(actor, slug, String(form.get("judge") ?? ""), { reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  revalidatePath(`/events/${slug}`, "layout");
  const withdrawn = out.withdrawn
    ? ` ${out.withdrawn} unstarted ${out.withdrawn === 1 ? "review was" : "reviews were"} withdrawn: a top-up fills ${out.withdrawn === 1 ? "that seat" : "those seats"}.`
    : "";
  return { ok: true, message: `Removed.${out.voided ? " What they saved stays on record, out of the ranking." : ""}${withdrawn}` };
}

export async function inviteJudgesAction(_prev: BatchInviteResult, form: FormData): Promise<BatchInviteResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    const made = inviteJudges(actor, slug, { lines: String(form.get("lines") ?? ""), trackIds: form.getAll("trackIds").map(String) });
    refresh(slug);
    const note = made.invites.length ? mailNote(await mailJudgeInvites(actor, slug, made.invites)) : null;
    const skipped = made.skipped.length
      ? ` Skipped ${made.skipped.length === 1 ? "one address that already judges" : `${made.skipped.length} addresses that already judge`} this event: ${made.skipped.map((s) => s.email).join(", ")}.`
      : "";
    const count = made.invites.length;
    const replaced = replacedNote(made.replaced);
    return {
      ok: true,
      message: count
        ? `${count === 1 ? "One invitation" : `${count} invitations`} ready.${note ? ` ${note}` : ""} Copy the links now: they are shown only once.${replaced ? ` ${replaced}` : ""}${skipped}`
        : `Nothing to make.${skipped}`,
      links: made.invites.map((i) => ({ name: i.name, email: i.email, path: i.path })),
      skipped: made.skipped,
    };
  } catch (err) {
    return actionError(err);
  }
}

/** Email reminders: one judge (form field judge) or every judge who has not started. */
export async function emailRemindersAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  const judge = form.get("judge");
  try {
    const report = await remindJudges(actor, slug, judge ? { judge: String(judge) } : { notStarted: true });
    refresh(slug);
    const later = report.tooSoon.length
      ? ` Not mailed again within the hour: ${report.tooSoon.map((t) => `${t.name} (in ${Math.ceil(t.retryAfter / 60)} min)`).join(", ")}.`
      : "";
    return { ok: true, message: `${mailedNote(report, "judge")}${later}` };
  } catch (err) {
    if (err instanceof RateLimitedError) {
      const minutes = Math.ceil(err.retryAfter / 60);
      return { ok: false, message: `Reminded within the last hour: the portal mails ${judge ? "this judge" : "them"} again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` };
    }
    return actionError(err);
  }
}
