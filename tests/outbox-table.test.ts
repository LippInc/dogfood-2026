import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutboxTable } from "@/components/outbox-table";
import type { OutboxPage, OutboxView } from "@/server/dal";

// The outbox table said "Failed" for every row that was not sent. A message whose connection broke after
// hand-over may have arrived, a row left at sending has no answer recorded, and an "off" row was not sent
// because email is off: none of them is a failure of the mail server, and a reader acts differently on each.

const row = (status: string, error: string | null = null, underway = false): OutboxView => ({
  id: `mail_${status}`,
  kind: "voter_link",
  toEmail: `${status}@example.org`,
  subject: "Your voting link",
  body: "body",
  status,
  error,
  createdAt: "2026-09-29T02:00:00.000Z",
  sentAt: status === "sent" ? "2026-09-29T02:00:01.000Z" : null,
  underway,
});

const render = (messages: OutboxView[], counts: OutboxPage["counts"]) =>
  renderToStaticMarkup(h(OutboxTable, { page: { messages, next: null, counts }, href: () => "#" }));

describe("the outbox table's result column", () => {
  it("names each status for what it is; only a failure is called Failed", () => {
    const html = render(
      [row("sent"), row("failed", "550 no such mailbox"), row("unknown", "Timeout"), row("sending"), row("off")],
      { total: 5, sent: 1, failed: 1, unknown: 2, sending: 0 },
    );
    expect(html.match(/>Failed</g)).toHaveLength(1);
    expect(html).toContain(">May have arrived<");
    expect(html).toContain(">No answer recorded<");
    expect(html).toContain(">Not sent: email is off<");
    expect(html).toContain("550 no such mailbox");
    expect(html).toContain("Timeout"); // the reason shows under an unknown row too
  });

  it("the count line adds the ones that may have arrived, and only when there are some", () => {
    expect(render([row("unknown", "Timeout")], { total: 1, sent: 0, failed: 0, unknown: 1, sending: 0 })).toMatch(/>1<\/span> may have arrived/);
    expect(render([row("sent")], { total: 1, sent: 1, failed: 0, unknown: 0, sending: 0 })).not.toContain("may have arrived");
  });

  it("a message still being sent says Sending and is counted apart; an old one left at sending has no answer recorded", () => {
    const html = render([row("sending", null, true), row("sending", null, false)], { total: 2, sent: 0, failed: 0, unknown: 1, sending: 1 });
    expect(html).toContain(">Sending…<");
    expect(html.match(/>No answer recorded</g)).toHaveLength(1);
    expect(html).toMatch(/>1<\/span> sending/);
    expect(html).toMatch(/>1<\/span> may have arrived/);
    const settled = render([row("sending", null, false)], { total: 1, sent: 0, failed: 0, unknown: 1, sending: 0 });
    expect(settled).not.toContain("Sending…");
    expect(settled).not.toMatch(/<\/span> sending/);
  });
});
