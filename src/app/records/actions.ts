"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor, issueAllRecords, issueOwnRecordRequest } from "@/server/dal";

/** Issue (or find) the signed-in person's own record, then open it. `kind` is checked in the DAL. */
export async function openOwnRecord(eventKey: string, kind: string) {
  const issued = issueOwnRecordRequest(await currentActor(), eventKey, { kind });
  redirect(`/records/${issued.id}`);
}

/** Organizers: issue every record not issued yet. */
export async function issueEveryRecord(eventKey: string) {
  issueAllRecords(await currentActor(), eventKey);
  revalidatePath(`/organize/${eventKey}/results`);
}
