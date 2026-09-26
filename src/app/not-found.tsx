import { Refusal } from "@/components/refusal";

export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="Nothing lives at this address">
      The event, project or link may have been renamed, or it never existed. Invite links stop working when a
      captain makes a new one.
    </Refusal>
  );
}
