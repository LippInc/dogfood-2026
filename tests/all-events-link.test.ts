import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicAllEventsLink } from "@/components/shell/public-shell";
import { allEventsLink, organizerTabs } from "@/components/shell/work-shell";

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

// The judge's finals page had no All events for a judge in two events (a sweep, 2026-09-29): every judge page with
// the work shell passes the console's way to the other events.
describe("every judge page's top bar", () => {
  it("passes allEventsHref wherever it renders the work shell", () => {
    const root = path.join(process.cwd(), "src/app/judge");
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "page.tsx") pages.push(p);
      }
    };
    walk(root);
    const shells = pages.filter((p) => fs.readFileSync(p, "utf8").includes("<WorkShell"));
    expect(shells.length).toBeGreaterThanOrEqual(2);
    const missing = shells.filter((p) => {
      const src = fs.readFileSync(p, "utf8");
      return src.split("<WorkShell").length - 1 > src.split("allEventsHref=").length - 1;
    });
    expect(missing.map((p) => path.relative(process.cwd(), p))).toEqual([]);
  });
});

// Two sweeps (2026-09-29) found no organizer page linking to the event's public side, and an empty Your events
// with no way on for a judge or participant who landed there.
describe("the organizer's ways out", () => {
  it("every organizer tab row ends with the event's public page", () => {
    const tabs = organizerTabs("sample-hack-2026", "Overview");
    expect(tabs.at(-1)).toEqual({ href: "/events/sample-hack-2026", label: "Public page", active: false });
  });

  it("an empty Your events for someone who cannot create one links to the events", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/organize/page.tsx"), "utf8");
    const empty = src.slice(src.indexOf("You organize no event yet. Only an administrator"));
    expect(empty.slice(0, empty.indexOf("</div>"))).toContain('href="/"');
  });
});
