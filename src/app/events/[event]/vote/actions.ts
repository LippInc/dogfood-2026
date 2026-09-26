"use server";

import { cookies } from "next/headers";
import { clientOf } from "@/lib/client";
import { actionError, castBallot, currentActor, voteCookieName, type ActionResult } from "@/server/dal";

export type CastResult = ActionResult & { picks?: string[] };

/** eventId only picks which cookie to read; the data layer checks the token against that event. */
export async function castAction(eventId: string, projectIds: string[]): Promise<CastResult> {
  const token = (await cookies()).get(voteCookieName(eventId))?.value ?? null;
  try {
    const out = castBallot(await currentActor(), eventId, token, { projectIds }, await clientOf());
    return { ok: true, message: "Saved", picks: out.picks };
  } catch (err) {
    return actionError(err);
  }
}
