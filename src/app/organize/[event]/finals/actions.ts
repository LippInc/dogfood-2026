"use server";

import { revalidatePath } from "next/cache";
import { actionError, addFinalist, closeFinals, currentActor, openFinals, removeFinalist, setFinalsPanel, type ActionResult } from "@/server/dal";

function refresh(slug: string) {
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/judge/${slug}`, "layout");
}

const text = (form: FormData, name: string) => {
  const v = String(form.get(name) ?? "").trim();
  return v === "" ? undefined : v;
};

export async function openFinalsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  const track = String(form.get("track") ?? "");
  try {
    const r = openFinals(await currentActor(), slug, { track: track === "" ? null : track, n: Number(form.get("n") ?? 3) });
    refresh(slug);
    return { ok: true, message: `Finals opened with ${r.finalists.length} finalists.` };
  } catch (err) {
    return actionError(err);
  }
}

export async function addFinalistAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    const r = addFinalist(await currentActor(), slug, String(form.get("finals") ?? ""), { project: String(form.get("project") ?? ""), reason: text(form, "reason") });
    refresh(slug);
    return { ok: true, message: r.added ? "Finalist added." : "Already a finalist." };
  } catch (err) {
    return actionError(err);
  }
}

export async function removeFinalistAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    removeFinalist(await currentActor(), slug, String(form.get("finals") ?? ""), String(form.get("project") ?? ""), { reason: text(form, "reason") });
    refresh(slug);
    return { ok: true, message: "Finalist taken off." };
  } catch (err) {
    return actionError(err);
  }
}

export async function panelAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    const r = setFinalsPanel(await currentActor(), slug, String(form.get("finals") ?? ""), {
      judges: form.getAll("judges").map(String),
      reason: String(form.get("reason") ?? "").trim() || undefined,
    });
    refresh(slug);
    return { ok: true, message: r.changed ? "Panel saved." : "The panel is as it was." };
  } catch (err) {
    return actionError(err);
  }
}

export async function closeFinalsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    closeFinals(await currentActor(), slug, String(form.get("finals") ?? ""), { reason: text(form, "reason") });
    refresh(slug);
    return { ok: true, message: "Finals closed." };
  } catch (err) {
    return actionError(err);
  }
}
