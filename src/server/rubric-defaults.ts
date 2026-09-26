import "server-only";

// Prompts and anchor texts for the three criteria every fixture score uses. The
// fixture import and a newly created event both start from these; the organizer
// edits labels, prompts and weights afterwards.

export const BUILTIN_CRITERIA: Record<string, { prompt: string; anchors: Record<string, string> }> = {
  functionality: {
    prompt: "Does it do what it promises?",
    anchors: {
      "1": "Does not run",
      "2": "Runs, but the main promise fails",
      "3": "Main path works with gaps",
      "4": "Works, a few rough edges",
      "5": "Works end to end, as claimed",
    },
  },
  quality: {
    prompt: "Would you ship this code and UX?",
    anchors: {
      "1": "Hard to follow or use",
      "2": "Works against the reader",
      "3": "Readable, some shortcuts",
      "4": "Solid, a few rough edges",
      "5": "Ready to hand to a stranger",
    },
  },
  innovation: {
    prompt: "An idea you have not seen before?",
    anchors: {
      "1": "A copy of something common",
      "2": "A familiar idea, lightly changed",
      "3": "A fresh angle on a known idea",
      "4": "An idea most people have not seen",
      "5": "Changes how you think about the problem",
    },
  },
};

export const DEFAULT_CRITERIA = ["functionality", "quality", "innovation"] as const;
