import { Refusal } from "@/components/refusal";

/** A code nobody holds: still a real 404, with what to do about this kind of link. */
export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="This team invite does not work">
      When a captain makes a new invite link, the old one stops working. Ask the captain for the current link.
    </Refusal>
  );
}
