import { describe, expect, it } from "vitest";
import { publicAllEventsLink } from "@/components/shell/public-shell";
import { allEventsLink } from "@/components/shell/work-shell";

// An organizer walking the portal (2026-09-29) found no way out of an event to the list of events, or to New event.

describe("the top bar's All events link", () => {
  it("leads to Your events from every page of one event on the organizer side", () => {
    expect(allEventsLink("/organize/sample-hack-2026")).toBe("/organize");
    expect(allEventsLink("/organize/sample-hack-2026/judges")).toBe("/organize");
  });

  it("is absent on the portal's own pages, whose name already links to the list", () => {
    expect(allEventsLink("/organize")).toBeNull();
    expect(allEventsLink("/organize/new")).toBeNull();
    expect(allEventsLink("/organize/accounts")).toBeNull();
    expect(allEventsLink("/organize/log")).toBeNull();
  });

  it("on the judge console only when the page asks (a judge with more than one event)", () => {
    expect(allEventsLink("/events/sample-hack-2026")).toBeNull();
    expect(allEventsLink("/events/sample-hack-2026", "/")).toBe("/");
  });
});

// A participant signed in to one event found no way to the others but signing out (2026-09-29).
describe("the event header's All events link (participants, judges, visitors)", () => {
  it("leads to the list of events once the portal holds more than one", () => {
    expect(publicAllEventsLink(2)).toBe("/");
    expect(publicAllEventsLink(7)).toBe("/");
  });

  it("is absent with one event, where the home page opens that event", () => {
    expect(publicAllEventsLink(1)).toBeNull();
    expect(publicAllEventsLink(0)).toBeNull();
  });
});
