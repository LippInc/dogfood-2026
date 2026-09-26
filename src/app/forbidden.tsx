import { Refusal } from "@/components/refusal";

export default function Forbidden() {
  return (
    <Refusal code="403 · Not yours to open" title="You are signed in, but this is not for you">
      Access here depends on your role in the event (participant, judge or organizer). The server refused the
      request, so nothing on this page was sent to your browser.
    </Refusal>
  );
}
