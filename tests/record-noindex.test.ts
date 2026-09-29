import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/server/errors";

// A signed record's page names its person: it asks search engines not to index it on every path generateMetadata
// takes (a judge's record, a participant's with and without a project, and an unknown record), while the Open Graph
// card for a pasted link stays.

const getRecord = vi.fn();
vi.mock("@/server/dal", async (original) => ({ ...(await original<typeof import("@/server/dal")>()), getRecord: (id: string) => getRecord(id) }));

const { generateMetadata } = await import("@/app/records/[record]/page");
const meta = (record: string) => generateMetadata({ params: Promise.resolve({ record }) } as Parameters<typeof generateMetadata>[0]);
const noindex = { index: false, follow: false };

describe("record pages are not indexed", () => {
  it("a participant's record with a project and an award: title, card and robots noindex, nofollow", async () => {
    getRecord.mockReturnValueOnce({
      envelope: {
        record: {
          id: "rec_1",
          kind: "participant",
          person: { name: "Ada Example" },
          event: { name: "Sample Hack" },
          project: { id: "p1", title: "Tide", team: "Team", track: null, awards: ["1st place, Health"] },
        },
      },
    });
    const m = await meta("rec_1");
    expect(m.title).toBe("Ada Example: certificate, Sample Hack");
    expect(m.openGraph).toMatchObject({ title: "Ada Example: certificate, Sample Hack", type: "article" });
    expect(m.description).toContain("1st place, Health");
    expect(m.robots).toEqual(noindex);
  });

  it("a participant's record without a project is not indexed", async () => {
    getRecord.mockReturnValueOnce({
      envelope: { record: { id: "rec_2", kind: "participant", person: { name: "Ada Example" }, event: { name: "Sample Hack" } } },
    });
    const m = await meta("rec_2");
    expect(m.description).toContain("their project");
    expect(m.robots).toEqual(noindex);
  });

  it("a judge's record is not indexed", async () => {
    getRecord.mockReturnValueOnce({
      envelope: { record: { id: "rec_3", kind: "judge", person: { name: "Jo Judge" }, event: { name: "Sample Hack" } } },
    });
    const m = await meta("rec_3");
    expect(m.title).toBe("Jo Judge: judging record, Sample Hack");
    expect(m.robots).toEqual(noindex);
  });

  it("an unknown record's page is not indexed either", async () => {
    getRecord.mockImplementationOnce(() => {
      throw new NotFoundError("Record");
    });
    const m = await meta("rec_nope");
    expect(m.title).toBe("Record");
    expect(m.robots).toEqual(noindex);
  });
});
