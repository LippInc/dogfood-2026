import { Refusal } from "@/components/refusal";

/** A code nobody holds: still a real 404, with what to do about this kind of link. */
export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="This voting link does not work">
      The organizers may have replaced the open voting link with a new one. Ask them for the current link.
    </Refusal>
  );
}
