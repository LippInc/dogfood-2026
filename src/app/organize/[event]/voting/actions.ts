"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  addListedVoters,
  currentActor,
  mailVoterLinks,
  makeVotingLink,
  restoreVoter,
  saveVotingSettings,
  voidVoter,
  type ActionResult,
} from "@/server/dal";
import { mailNote } from "@/lib/mail-note";

export type LinkResult = ActionResult & { path?: string };
export type ListResult = ActionResult & { links?: { email: string; path: string }[] };

function refresh(slug: string) {
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/events/${slug}`, "layout");
}

export async function votingSettingsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    saveVotingSettings(actor, slug, {
      votingOpenAt: form.get("votingOpenAt") ?? "",
      votingCloseAt: form.get("votingCloseAt") ?? "",
      modes: form.getAll("modes").map(String),
      votesPerVoter: form.get("votesPerVoter"),
      // sent only while the choice is still open; left out, it stays as it is
      countLink: form.get("countLinkField") ? form.get("countLink") === "on" : undefined,
    });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: "Voting settings saved." };
}

export async function votingLinkAction(_prev: LinkResult, form: FormData): Promise<LinkResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    const { path } = makeVotingLink(actor, slug);
    refresh(slug);
    return { ok: true, message: "New voting link. Copy it now: it is shown only once, and the old one stopped working.", path };
  } catch (err) {
    return actionError(err);
  }
}

export async function votersAction(_prev: ListResult, form: FormData): Promise<ListResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    const { links, skipped } = addListedVoters(actor, slug, { emails: form.get("emails") ?? "" });
    refresh(slug);
    const note = mailNote(await mailVoterLinks(actor, slug, links));
    return {
      ok: true,
      links,
      message: `${note ? `${note} ` : ""}${links.length} personal ${links.length === 1 ? "link" : "links"} made${skipped ? `, ${skipped} already on the list` : ""}. Copy them now: each is shown only once.`,
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function voidAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    voidVoter(actor, slug, { voterId: form.get("voter"), reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: "Set aside. Its picks no longer count." };
}

export async function restoreAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    restoreVoter(actor, slug, { voterId: form.get("voter") });
  } catch (err) {
    return actionError(err);
  }
  refresh(slug);
  return { ok: true, message: "Restored. Its picks count again." };
}
