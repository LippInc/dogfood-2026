"use server";

import { revalidatePath } from "next/cache";
import {
  acceptUnderReviewed,
  actionError,
  currentActor,
  dismissDuplicate,
  mergeDuplicate,
  publishResults,
  revokeJudgeOverride,
  runAssignment,
  setJudgeOverride,
  settleCloseCall,
  undoAcceptUnderReviewed,
  undoCloseCall,
  undoNotDuplicate,
  unmergeDuplicate,
  type ActionResult,
} from "@/server/dal";

// Each decision on the overview is settled by one audited call in the data access
// layer; these actions only read the form and refresh the pages that show it.

async function settle(form: FormData, work: (slug: string) => unknown, done: string): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    work(slug);
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/events/${slug}`, "layout");
  revalidatePath(`/judge/${slug}`);
  return { ok: true, message: done };
}

export async function overrideAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const mode = String(form.get("mode") ?? "");
  return settle(
    form,
    (slug) => setJudgeOverride(actor, slug, { judgeUserId: form.get("judge"), mode, reason: form.get("reason") ?? "" }),
    mode === "include" ? "Reinstated. The engine counts this judge again." : "Recorded: the judge stays left out.",
  );
}

export async function undoOverrideAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => revokeJudgeOverride(actor, slug, { judgeUserId: form.get("judge") }), "Undone. The flat-judge rule applies again.");
}

export async function mergeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(
    form,
    (slug) => mergeDuplicate(actor, slug, { keepId: form.get("keep"), duplicateId: form.get("duplicate") }),
    "Merged. Both copies stay in the raw table; the engine counts one project.",
  );
}

export async function notDuplicateAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(
    form,
    (slug) => dismissDuplicate(actor, slug, { ids: form.getAll("ids").map(String), reason: form.get("reason") ?? "" }),
    "Recorded: these are different projects.",
  );
}

export async function unmergeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => unmergeDuplicate(actor, slug, { duplicateId: form.get("duplicate") }), "Undone. Both copies count as projects again.");
}

export async function undoNotDuplicateAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => undoNotDuplicate(actor, slug, { ids: form.getAll("ids").map(String) }), "Undone. The copies are flagged as a duplicate again.");
}

export async function undoAcceptAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => undoAcceptUnderReviewed(actor, slug, { projectId: form.get("project") }), "Undone. The project is an open decision again.");
}

export async function acceptAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(
    form,
    (slug) => acceptUnderReviewed(actor, slug, { projectId: form.get("project"), reason: form.get("reason") ?? "" }),
    "Recorded: it is published with the reviews it has, and marked.",
  );
}

export async function topUpAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  let added = 0;
  const result = await settle(
    form,
    (slug) => {
      added = runAssignment(actor, slug, { mode: "topup" }).added;
    },
    "",
  );
  if (!result.ok) return result;
  return {
    ok: true,
    message: added
      ? `${added} ${added === 1 ? "review" : "reviews"} assigned. The decision settles itself when they are finished.`
      : "Nothing to assign: no eligible judge is left in this track. Publish it as it is, or assign a judge by hand on the Judges page.",
  };
}

export async function publishAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  if (form.get("confirm") !== "yes") return { ok: false, message: "Tick the box to confirm." };
  const reason = form.get("reason");
  return settle(form, (slug) => publishResults(actor, slug, typeof reason === "string" && reason.trim() ? { reason } : {}), "Published.");
}

export async function keepRankingAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => settleCloseCall(actor, slug, String(form.get("track") ?? ""), { mode: "keep" }), "Recorded: the ranking's winner stands.");
}

export async function judgesDecisionAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const winner = form.get("winner");
  if (typeof winner !== "string" || !winner) return { ok: false, message: "Choose the project the judges named." };
  return settle(
    form,
    (slug) => settleCloseCall(actor, slug, String(form.get("track") ?? ""), { mode: "judges", winnerId: winner, reason: form.get("reason") ?? "" }),
    "Recorded: the judges' decision names this track's winner.",
  );
}

export async function undoCloseCallAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return settle(form, (slug) => undoCloseCall(actor, slug, String(form.get("track") ?? "")), "Undone. The close call is open again.");
}
