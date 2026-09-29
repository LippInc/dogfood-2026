import { currentActor, helpViewer } from "@/server/dal";
import { HelpButton } from "./help-panel";

/**
 * The top bar's Help button with the signed-in person's roles, read on the server through the data access layer
 * (the panel itself runs in the browser and asks nothing of the server). `event` is the event in view, for the
 * panel's links; `questionKey` false leaves the ? key to the page (the judge console and the compare page).
 */
export async function HelpSlot({
  event,
  variant,
  questionKey = true,
}: {
  event?: { slug: string; name: string } | null;
  variant: "public" | "work" | "menu";
  questionKey?: boolean;
}) {
  // reading the session (cookies, headers) keeps it out of the build; no connection() of its own, so a page
  // rendered outside a request (tests/judges-not-started.test.ts renders the Judges page so) still renders
  const viewer = helpViewer(await currentActor(), event);
  return <HelpButton viewer={viewer} variant={variant} questionKey={questionKey} />;
}
