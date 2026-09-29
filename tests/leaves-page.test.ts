import { describe, expect, it } from "vitest";
import { leavesPage, type LinkClick } from "@/lib/leaves-page";

// Follow-up item 2 on the ballot: a section link in the public shell changed the page on the
// client, unmounting the ballot and dropping a pick that was waiting to be saved. The ballot now
// asks first on every click that leaves the page; this is the rule for which clicks do.

const here = "http://localhost:8080/events/dogfood/vote";
const click = (over: Partial<LinkClick> = {}): LinkClick => ({
  href: "/events/dogfood",
  target: null,
  download: false,
  button: 0,
  modified: false,
  defaultPrevented: false,
  ...over,
});

describe("leavesPage", () => {
  it("a plain click on a link to another page of the portal leaves", () => {
    expect(leavesPage(click(), here)).toBe(true);
    expect(leavesPage(click({ href: "http://localhost:8080/events" }), here)).toBe(true);
    expect(leavesPage(click({ href: "/events/dogfood/vote?x=1" }), here)).toBe(true);
    expect(leavesPage(click({ target: "_self" }), here)).toBe(true);
  });

  it("new tabs, downloads, handled clicks, other sites and same-page anchors do not", () => {
    expect(leavesPage(click({ modified: true }), here)).toBe(false);
    expect(leavesPage(click({ button: 1 }), here)).toBe(false);
    expect(leavesPage(click({ target: "_blank" }), here)).toBe(false);
    expect(leavesPage(click({ download: true }), here)).toBe(false);
    expect(leavesPage(click({ defaultPrevented: true }), here)).toBe(false);
    expect(leavesPage(click({ href: "https://example.org/" }), here)).toBe(false);
    expect(leavesPage(click({ href: "mailto:a@b.c" }), here)).toBe(false);
    expect(leavesPage(click({ href: "#ballot-title" }), here)).toBe(false);
    expect(leavesPage(click({ href: null }), here)).toBe(false);
  });

  // Follow-up item 2: the shell's own "Vote" section link, clicked on the vote page, asked
  // "Leave this page anyway?" although the page stays where it is.
  it("a link to the page itself (same path, query and #fragment) does not leave", () => {
    expect(leavesPage(click({ href: "/events/dogfood/vote" }), here)).toBe(false);
    expect(leavesPage(click({ href: "http://localhost:8080/events/dogfood/vote" }), here)).toBe(false);
    expect(leavesPage(click({ href: "/events/dogfood/vote?track=ai" }), `${here}?track=ai`)).toBe(false);
    expect(leavesPage(click({ href: "/events/dogfood/vote#ballot-title" }), `${here}#ballot-title`)).toBe(false);
  });

  it("positive control: the same path with another query, or without the #fragment the page is on, still leaves", () => {
    expect(leavesPage(click({ href: "/events/dogfood/vote?track=ai" }), here)).toBe(true);
    expect(leavesPage(click({ href: "/events/dogfood/vote" }), `${here}?track=ai`)).toBe(true);
    expect(leavesPage(click({ href: "/events/dogfood/vote" }), `${here}#ballot-title`)).toBe(true);
  });
});
