"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  assignByHand,
  currentActor,
  inviteJudge,
  mailJudgeInvite,
  revokeJudgeInvite,
  runAssignment,
  setJudgeTracks,
  type ActionResult,
} from "@/server/dal";
import { mailNote } from "@/lib/mail-note";

export type InviteResult = ActionResult & { path?: string };
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
    return { ok: true, message: `${note ? `${note} ` : ""}Invitation ready. Copy the link now: it is shown only once.`, path: invite.path };
  } catch (err) {
    return actionError(err);
  }
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    revokeJudgeInvite(actor, String(form.get("invite") ?? ""));
  } catch (err) {
    actionError(err);
  }
  refresh(slug);
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
  return { ok: true, message: "Tracks saved. Existing assignments stay; the next top-up uses the new tracks." };
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
