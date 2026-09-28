import { Refusal } from "@/components/refusal";

/** A personal link nobody holds: still a real 404, with who makes a working one. */
export default function NotFound() {
  return (
    <Refusal code="404 · Not found" title="This personal link does not work">
      The portal knows no personal link like this one. When the organizers make a new batch of links, the ones not used yet stop working. Ask the
      event&apos;s organizers for your current link.
    </Refusal>
  );
}
