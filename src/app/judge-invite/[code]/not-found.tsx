import { Refusal } from "@/components/refusal";

/** A code nobody holds: still a real 404, with what to do about this kind of link. */
export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="This invitation link does not work">
      The organizer may have withdrawn it or made a new one, and each link admits one judge. Check that the whole link was copied, or ask the organizer for a fresh one.
    </Refusal>
  );
}
