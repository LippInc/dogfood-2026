import { buildMatcher, COVERAGE_FLOOR, MATCH_FLOOR, RELATIVE_FLOOR, WORD_SHARE_FLOOR, type Matcher } from "./match";

/**
 * The Help panel's guide: every page a person can reach, the tasks the README tour walks through, and the ideas a
 * judge of this portal asks about. Written from README.md, docs/FEATURES.md, docs/OPERATIONS.md, JUDGING.md and the
 * pages themselves; each sentence is meant to be true of the code. tests/help.test.ts holds every href to a route
 * file under src/app, every audience to a real role and every doc heading to its file.
 *
 * It ships with the page and is matched in the browser (./match.ts): nothing a person types is sent anywhere.
 */

/** Who an entry is for. "signed-in" is anyone with an account; "participant" is a team member. */
export type HelpAudience = "everyone" | "signed-in" | "participant" | "judge" | "organizer" | "admin";
/** The roles a signed-in person can hold (user_roles.role, plus the portal's administrators). */
export type HelpRole = "participant" | "judge" | "organizer" | "admin";

export type HelpEntry = {
  id: string;
  kind: "page" | "task" | "concept";
  /** the page's own name, or the task or idea in a few words */
  title: string;
  /** a route under src/app; "[event]" is filled with the event in view (or the viewer's), any other part is not linked */
  href: string | null;
  who: HelpAudience[];
  /** one or two plain sentences */
  answer: string;
  /** the words people type for it */
  keywords: string[];
  /** for ideas: the file in the repository and the heading to read */
  doc?: { file: string; heading: string };
};

export type HelpViewer = {
  signedIn: boolean;
  roles: HelpRole[];
  /** the event whose pages the links point at: the one in view, else one of the viewer's, else the first */
  event: { slug: string; name: string } | null;
};

export const HELP_ENTRIES: HelpEntry[] = [
  // ---- pages everyone can open -------------------------------------------------------------------------------
  {
    id: "events",
    kind: "page",
    title: "Events",
    href: "/",
    who: ["everyone"],
    answer: "The portal's front page lists every event, what is on now first. With only one event it opens that event's projects straight away.",
    keywords: ["home", "front page", "start", "list of events", "hackathons", "all events", "main page"],
  },
  {
    id: "gallery",
    kind: "page",
    title: "Projects (the gallery)",
    href: "/events/[event]",
    who: ["everyone"],
    answer:
      "Every submitted project on one page: the field of faces, one column per track, then the list in a new order each visit. Search by title, team, track or tag, or choose a track to filter.",
    keywords: ["gallery", "projects", "submissions", "browse", "entries", "search projects", "filter by track", "field", "faces", "all projects", "showcase"],
  },
  {
    id: "tracks",
    kind: "concept",
    title: "Tracks",
    href: "/events/[event]",
    who: ["everyone"],
    answer:
      "A track is one of the event's categories. Each project is entered in one track, the gallery shows one column per track, judges are invited for chosen tracks and given projects from those tracks alone, and the results rank projects within each track.",
    keywords: ["track", "tracks", "what is a track", "category", "categories", "which track", "theme"],
    doc: { file: "JUDGING.md", heading: "Assignment" },
  },
  {
    id: "project-page",
    kind: "page",
    title: "A project's page",
    href: "/events/[event]",
    who: ["everyone"],
    answer:
      "Open any project from the gallery: its page has the team, the write-up, links, pictures and comments, and once results are out its place and score with the ±.",
    keywords: ["project details", "project page", "one project", "demo link", "repository", "repo", "description", "team members", "who can see my project", "can other teams see my project"],
  },
  {
    id: "about",
    kind: "page",
    title: "About",
    href: "/events/[event]/about",
    who: ["everyone"],
    answer: "The event's dates (submissions, judging, voting), its tracks, prizes and the rubric judges score against, with each criterion's weight. Times are shown in UTC. Organizers set the dates in Settings and the vote's window on the Community vote tab.",
    keywords: ["dates", "deadline", "when", "schedule", "timeline", "rules", "prizes", "what are the prizes", "which prizes", "prizes to win", "tracks", "criteria", "rubric", "how are projects judged", "submissions close", "submit until", "voting opens", "voting closes", "vote until", "when is the event", "time zone"],
  },
  {
    id: "updates-public",
    kind: "page",
    title: "Updates",
    href: "/events/[event]/updates",
    who: ["everyone"],
    answer:
      "The organizers' news to the event, newest first: a deadline moved, judging has started, when the winners are announced. The newest three also show on the event's Projects and About pages.",
    keywords: ["updates", "news", "announcements", "announcement", "what's new", "latest news", "deadline extended", "organizer news"],
    doc: { file: "docs/FEATURES.md", heading: "Updates" },
  },
  {
    id: "results-public",
    kind: "page",
    title: "Results",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "Hidden until the organizers publish. Then every project in every track shows its place and its score with the ±, the prizes show with their winners, and \"How this ranking was reached\" explains the method.",
    keywords: ["results", "winners", "who won", "ranking", "leaderboard", "places", "standings", "final scores", "public results", "results out", "results come out", "when are results out", "verify the results", "check the results"],
  },
  {
    id: "results-overall",
    kind: "page",
    title: "Overall order",
    href: "/events/[event]/results/overall",
    who: ["everyone"],
    answer:
      "Linked from Results and hidden as long as they are: every project in one order by score across tracks, each beside its track and its place there. Places and prizes are still decided within each track; in pairwise mode it says why there is no overall order.",
    keywords: ["overall", "overall ranking", "all tracks", "across tracks", "one list", "overall winner", "best overall", "top projects", "overall order"],
  },
  {
    id: "sign-in",
    kind: "page",
    title: "Sign in",
    href: "/sign-in",
    who: ["everyone"],
    answer:
      "Sign in with your email and password. On the demo portal the same page has one-click sign-ins: Demo Organizer, Judge A (Diego Herrera), Judge B (Jonas Vogel) and priya1 (a team member).",
    keywords: ["sign in", "log in", "login", "account", "password", "demo identities", "one click", "judge a", "judge b", "priya1", "demo organizer"],
  },
  {
    id: "sign-out",
    kind: "task",
    title: "Sign out",
    href: null,
    who: ["signed-in"],
    answer:
      "On the event's pages, Sign out is in the top bar (on a phone, in the Menu); on the judging and organizer pages it is in the account menu, the person icon at the top right. It ends this browser's session; your API tokens keep working until you revoke them.",
    keywords: ["sign out", "log out", "logout", "logout button", "sign out button", "leave my account", "end session", "switch account"],
  },
  {
    id: "sign-up",
    kind: "page",
    title: "Create an account",
    href: "/sign-up",
    who: ["everyone"],
    answer: "Make an account with your name, email and a password. Taking part, judging and voting all start from an account.",
    keywords: ["sign up", "register", "new account", "create account", "join the portal"],
  },
  {
    id: "change-password",
    kind: "task",
    title: "Change your password",
    href: null,
    who: ["everyone"],
    answer:
      "The portal has no page to change your own password. A portal administrator makes you a one-time reset link on Accounts; opening it sets a new password and signs you out everywhere else.",
    keywords: ["change password", "change my password", "new password", "update password", "forgot my password", "password"],
    doc: { file: "README.md", heading: "What it does not do yet" },
  },
  {
    id: "verify",
    kind: "page",
    title: "Check a signed record",
    href: "/verify",
    who: ["everyone"],
    answer:
      "Paste a certificate or judging record, or open its file: your browser checks the Ed25519 signature against the portal's published key, and the portal checks it too. No account needed.",
    keywords: ["verify", "check certificate", "is this real", "fake", "signature", "validate", "ed25519", "authentic", "genuine", "tampered"],
    doc: { file: "docs/FEATURES.md", heading: "Signed certificates and judging records" },
  },
  {
    id: "privacy",
    kind: "page",
    title: "What we keep",
    href: "/privacy",
    who: ["everyone"],
    answer: "Everything the portal stores about people, how long it stays and what removes it. There are no analytics or tracking scripts, and no raw network addresses are stored.",
    keywords: ["privacy", "personal data", "gdpr", "data kept", "tracking", "is my activity tracked", "activity", "cookies", "delete my data", "delete my account", "who can see my email", "retention", "what do you store", "is my data safe", "data safe"],
    doc: { file: "docs/OPERATIONS.md", heading: "Personal data" },
  },
  {
    id: "api-docs",
    kind: "page",
    title: "API",
    href: "/api-docs",
    who: ["everyone"],
    answer:
      "The API reference: every action in the interface is also a JSON route, with the same permission checks and every status it can answer. The OpenAPI 3.1 document is at /api/openapi.json.",
    keywords: ["api docs", "api reference", "documentation", "rest", "json", "openapi", "swagger", "endpoints", "routes", "developer", "integration"],
    doc: { file: "docs/FEATURES.md", heading: "API and webhooks" },
  },
  {
    id: "mode",
    kind: "task",
    title: "Light and dark mode",
    href: null,
    who: ["everyone"],
    answer: "The sun or moon button in the top bar switches between light and dark. The choice is kept in a cookie; until you pick one, the page follows your system.",
    keywords: ["dark mode", "light mode", "theme", "night", "colours", "colors", "contrast"],
  },

  // ---- teams --------------------------------------------------------------------------------------------------
  {
    id: "my-project",
    kind: "page",
    title: "My project",
    href: "/events/[event]/my-project",
    who: ["signed-in", "participant"],
    answer:
      "Your team's page: start or join a team, fill in the project and hand it in before the close. Once results are published it shows your place, your score with its ±, each review's feedback and your certificate.",
    keywords: ["my project", "my team", "team page", "my submission", "my feedback", "my score", "my place", "take part", "participate"],
  },
  {
    id: "hand-in",
    kind: "task",
    title: "Hand in a project",
    href: "/events/[event]/my-project",
    who: ["signed-in", "participant"],
    answer:
      "On My project, Start a team (or join one with a teammate's invite link), fill in the title and one-line summary, Save draft, then Submit project. You can edit it until submissions close; the server refuses changes after that.",
    keywords: ["submit", "hand in", "submit project", "save draft", "edit my project", "enter the hackathon", "upload project", "take part", "start a team", "submit late", "late"],
    doc: { file: "README.md", heading: "A guided tour" },
  },
  {
    id: "teams",
    kind: "task",
    title: "Teams and invite links",
    href: "/events/[event]/my-project",
    who: ["signed-in", "participant"],
    answer:
      "Start a team on My project and share its invite link; teammates open it to join. Before the deadline a member can rename the team or leave, and the captain can take a member off or hand over the captaincy. The last member can dissolve the team, which deletes its draft; a submitted project stays.",
    keywords: ["team", "teammate", "join team", "invite link", "add member", "captain", "leave team", "rename team", "change team name", "team name", "team size", "people per team", "dissolve"],
    doc: { file: "docs/FEATURES.md", heading: "Events and teams" },
  },
  {
    id: "my-feedback",
    kind: "task",
    title: "Your reviews and place",
    href: "/events/[event]/my-project",
    who: ["participant"],
    answer: "After the results are published, My project shows your team's place, the score with its ±, and each judge's written feedback, with the judges unnamed. The place and score are public on the Results page too; the written feedback is on no public page.",
    keywords: ["my reviews", "feedback", "what did judges say", "my score", "judge comments", "my place", "how did we do", "who can see my score", "who can see my feedback", "can participants see scores", "participants see scores"],
  },
  {
    id: "comments",
    kind: "task",
    title: "Comments on a project",
    href: "/events/[event]",
    who: ["signed-in", "organizer"],
    answer:
      "Signed in, you can comment on any project's page and delete your own comments; they cannot be edited. An organizer can hide a comment with a reason and unhide it again.",
    keywords: ["comment", "comments", "discussion", "hide comment", "delete comment", "moderate", "reply", "leave a comment", "write a comment", "post a comment"],
    doc: { file: "docs/FEATURES.md", heading: "Comments" },
  },

  // ---- community vote -----------------------------------------------------------------------------------------
  {
    id: "vote",
    kind: "page",
    title: "Vote",
    href: "/events/[event]/vote",
    who: ["signed-in"],
    answer:
      "While the community vote is open, pick up to three favourite projects; each pick saves at once. Nobody signed in can vote for their own team's project, and the count stays hidden until voting closes.",
    keywords: ["vote", "voting", "ballot", "favourites", "favorites", "pick", "community vote", "peoples choice", "how do i vote", "cast a vote", "vote for projects", "vote for my own team"],
    doc: { file: "docs/FEATURES.md", heading: "Community vote" },
  },
  {
    id: "ballots",
    kind: "concept",
    title: "Ballots",
    href: "/events/[event]/vote",
    who: ["everyone"],
    answer:
      "A ballot is one person's vote: up to three favourite projects (the organizer can set how many), listed in that voter's own shuffled order. One ballot per person the portal can name.",
    keywords: ["ballot", "what is a ballot", "how many votes", "three picks", "shuffled order", "random order", "one vote each"],
    doc: { file: "docs/FEATURES.md", heading: "Community vote" },
  },
  {
    id: "open-link",
    kind: "concept",
    title: "Open-link votes",
    href: "/organize/[event]/voting",
    who: ["everyone"],
    answer:
      "Anyone with the open link can vote, one ballot per browser. Since nobody can tell who holds the link, its ballots are counted apart in their own column and change no place unless the organizer chose, before the first ballot, to add them.",
    keywords: ["open link", "vote link", "link vote", "anonymous vote", "counted apart", "separate column", "vote without account"],
    doc: { file: "docs/FEATURES.md", heading: "Community vote" },
  },
  {
    id: "vote-hidden",
    kind: "concept",
    title: "Why the vote count is hidden",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "While voting is open only the organizers see the count; everyone sees it when the window closes, and it is final from then on. Publishing the results closes an open vote, so nobody votes with the ranking in view.",
    keywords: ["hidden votes", "how many votes", "tally", "vote results", "see the votes", "null count", "public count"],
    doc: { file: "docs/FEATURES.md", heading: "Community vote" },
  },

  // ---- judges -------------------------------------------------------------------------------------------------
  {
    id: "judging-close",
    kind: "task",
    title: "When judging closes",
    href: "/events/[event]/about",
    who: ["everyone"],
    answer:
      "Judging starts when submissions close. Organizers set \"Judging closes\" (UTC) in Settings; the event's About page shows it in its timeline and the judge console says when judging closes. Scoring stops then, or when results are published if that comes first; with no time set, judging runs until publishing.",
    keywords: ["when", "judging closes", "judging close", "judging ends", "judging end", "end of judging", "close time", "judging time", "how long can judges score", "timeline", "judging start", "judging starts", "when does judging start"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "how-scored",
    kind: "concept",
    title: "How projects are scored",
    href: null,
    who: ["everyone"],
    answer:
      "Judges score each rubric criterion (1 to 5 on the sample event); a review's total is Σ weight × score ÷ Σ weight and counts only once every criterion is scored. Each judge's leniency is corrected before ranking, and every score carries its ±; in pairwise mode judges pick the better of two instead.",
    keywords: ["how are projects scored", "projects scored", "how scoring works", "score calculation", "calculated", "total score", "weighted total", "review total", "how is the score calculated", "how does judging work", "how judging works", "how winners are chosen", "winners chosen"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "judge-console",
    kind: "page",
    title: "Score in the judge console",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "Where a judge scores the projects they were given: keys 1 to 5 score each criterion, every change saves by itself, and \"your ranking so far\" lists your own finished reviews. You only ever see your own scores.",
    keywords: ["judge console", "score", "scoring", "rate projects", "my batch", "my scores", "judging", "review projects", "grade", "autosave", "where do i judge", "score a project", "edit a score"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "judge-keys",
    kind: "task",
    title: "Score with the keyboard",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "In the console, 1 to 5 scores a criterion and moves on, ↑ ↓ change criterion, C writes feedback, Ctrl+Enter saves and opens the next project, J and K move through your batch. ? lists the keys and can turn the single-key ones off.",
    keywords: ["keyboard", "keys", "shortcuts", "hotkeys", "1 to 5", "ctrl enter", "j k", "next project", "letters off"],
  },
  {
    id: "other-judges",
    kind: "concept",
    title: "Other judges' scores",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "A judge sees only their own scores. Asking for another judge's scores is refused with 403, and that refusal is written to the audit log.",
    keywords: ["other judges scores", "see other judges", "peer scores", "403", "forbidden", "isolation", "can i see", "another judge", "who can see my scores"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "conflict",
    kind: "task",
    title: "Declare a conflict of interest",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "In the judge console, \"Declare a conflict of interest\" takes the project out of your batch; the organizers see why. A judge on a project's team is never given it.",
    keywords: ["conflict of interest", "recuse", "recusal", "i know this team", "friend", "my own team", "judge my own project", "skip project"],
    doc: { file: "JUDGING.md", heading: "Assignment" },
  },
  {
    id: "pairwise-compare",
    kind: "page",
    title: "Compare (pairwise judging)",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "When the organizer chooses pairwise judging, the judge console asks \"which is better?\" about two of your projects at a time: ← or → for the better one, T for too close to call, U to take back your last answer.",
    keywords: ["compare", "which is better", "left right", "too close to call", "tie", "undo answer", "pairwise console", "arrow keys"],
    doc: { file: "JUDGING.md", heading: "Pairwise mode" },
  },
  {
    id: "judge-invite",
    kind: "task",
    title: "Accept a judge invitation",
    href: "/sign-in",
    who: ["everyone"],
    answer:
      "Open the invitation link the organizers sent you, sign in (or create an account) and press \"Accept and open the judging console\": you judge the tracks they chose.",
    keywords: ["judge invitation", "invite link", "become a judge", "accept invitation", "judge link"],
  },
  {
    id: "judge-record",
    kind: "task",
    title: "Get your signed judging record",
    href: "/judge/[event]",
    who: ["judge"],
    answer:
      "Once results are published, a judge with a finished review gets \"Get your signed judging record\" in the console's top bar. The record is signed with the portal's key and anyone can check it on Check a signed record.",
    keywords: ["judging record", "judge certificate", "proof of judging", "judge participation", "record"],
    doc: { file: "docs/FEATURES.md", heading: "Signed certificates and judging records" },
  },

  // ---- organizers: pages --------------------------------------------------------------------------------------
  {
    id: "your-events",
    kind: "page",
    title: "Your events",
    href: "/organize",
    who: ["organizer", "admin"],
    answer:
      "The events you organize, each with what waits on you. An administrator also makes a new event or imports one here, and reaches Accounts and Portal log.",
    keywords: ["your events", "my events", "organizer home", "dashboard", "events i run", "manage events"],
  },
  {
    id: "overview",
    kind: "page",
    title: "Overview",
    href: "/organize/[event]",
    who: ["organizer"],
    answer:
      "The organizer's first screen: the event's ten stages, the decisions that must be made before results can go out, the locked Publish panel, and summaries of judges, normalization and the audit log. It refreshes itself every 15 s.",
    keywords: ["overview", "organizer dashboard", "decisions", "needs you", "pipeline", "stages", "progress", "what needs doing"],
  },
  {
    id: "submissions",
    kind: "page",
    title: "Submissions",
    href: "/organize/[event]/submissions",
    who: ["organizer"],
    answer:
      "Every project with its team, when it came in and its review count, filtered by track or \"needs a look\". Open a project for its judging (fix an assignment, undo a recusal, move its track), or a team to change it after the close.",
    keywords: ["submissions", "all projects", "drafts", "late", "review count", "team changes", "projects.csv", "who submitted"],
  },
  {
    id: "judges-tab",
    kind: "page",
    title: "Judges",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "Every judge with their tracks, finished reviews and leniency; invite judges by link, change a judge's tracks, remove one, and run the assignment (a top-up fills only missing reviews).",
    keywords: ["judges", "judge list", "judge progress", "who has finished", "reminders", "remove judge", "judge tracks", "load"],
  },
  {
    id: "voting-tab",
    kind: "page",
    title: "Community vote",
    href: "/organize/[event]/voting",
    who: ["organizer"],
    answer:
      "The vote's window and who may vote (accounts, a voter list, the open link), the live count only organizers see while it is open, suspected duplicate ballots to set aside, and personal voter links.",
    keywords: ["voting tab", "votes", "vote count", "see votes", "live count", "turnout", "voter list", "duplicate ballots", "voting window", "open voting", "close voting"],
    doc: { file: "docs/FEATURES.md", heading: "Community vote" },
  },
  {
    id: "results-organizer",
    kind: "page",
    title: "Results and their working",
    href: "/organize/[event]/results",
    who: ["organizer"],
    answer:
      "The ranking as it will be published (a preview until you publish), each project's receipt of reviews, leniency and ±, the judge ledger, the Prizes step, and \"Issue every record\" once published.",
    keywords: ["organizer results", "receipts", "working", "preview ranking", "judge ledger", "normalized ranking", "show the working", "how scores were worked out"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "audit-tab",
    kind: "page",
    title: "Audit log",
    href: "/organize/[event]/audit",
    who: ["organizer"],
    answer:
      "Every change in the event and every request refused to someone signed in, newest first, with the chain's head hash and a download as audit.csv. Rows cannot be edited or deleted: the database refuses it.",
    keywords: ["audit log", "history", "who changed", "log", "activity", "trail", "audit.csv", "refusals", "what happened"],
    doc: { file: "JUDGING.md", heading: "The audit trail" },
  },
  {
    id: "integrations",
    kind: "page",
    title: "Integrations",
    href: "/organize/[event]/integrations",
    who: ["organizer"],
    answer:
      "The API and a link to your API tokens, webhooks with their delivery log, the email outbox, every export (CSV, event.json, fixtures.json), personal links for imported people, and the embed code for your own site.",
    keywords: ["integrations", "webhooks", "api", "exports", "embed", "email outbox", "personal links", "claim links"],
  },
  {
    id: "settings",
    kind: "page",
    title: "Settings",
    href: "/organize/[event]/settings",
    who: ["organizer"],
    answer:
      "The event's name, dates, team size and certificate places, its organizers, tracks, prizes, what teams fill in, questions for teams, how judges judge (scores or pairwise), the scoring rubric with its weights and how exact ties are broken. Every save is audited.",
    keywords: ["settings", "configure", "dates", "deadline", "team size", "tracks", "prizes", "rubric", "weights", "criteria", "questions", "fields", "co-organizer", "change the deadline", "extend the deadline", "change dates", "close submissions", "reopen submissions", "extend submissions", "submission deadline", "add tracks"],
  },
  {
    id: "post-update",
    kind: "task",
    title: "Post an update",
    href: "/organize/[event]/updates",
    who: ["organizer"],
    answer:
      "Settings links to Updates: write a title and plain text, and it shows on the event's public pages at once; edit or remove it there, the audit log keeping the old words. Updates can go out after publishing too. With email on (SMTP_URL set) a box, off by default, also mails it to everyone on a team.",
    keywords: ["post update", "announce", "announcement", "news", "tell participants", "email participants", "deadline extended", "broadcast", "message everyone"],
    doc: { file: "docs/FEATURES.md", heading: "Updates" },
  },
  {
    id: "team-organizer",
    kind: "task",
    title: "Change a team after the close",
    href: "/organize/[event]/submissions",
    who: ["organizer"],
    answer:
      "Open the team from Submissions: an organizer renames it, adds someone or takes someone off, each with a reason for the audit log, until results are published. The project page says the organizers changed the team.",
    keywords: ["change team", "change team name", "add member after the close", "take someone off a team", "rename team", "team page organizer"],
    doc: { file: "docs/FEATURES.md", heading: "Events and teams" },
  },
  {
    id: "new-event",
    kind: "page",
    title: "New event",
    href: "/organize/new",
    who: ["admin"],
    answer:
      "An administrator creates an event with a name, dates, team size and tracks, and becomes its organizer. \"Start from the settings of\" copies another event's settings, never its people or projects.",
    keywords: ["new event", "create event", "make an event", "second event", "copy settings", "next year", "run again"],
    doc: { file: "docs/OPERATIONS.md", heading: "People and accounts" },
  },
  {
    id: "accounts",
    kind: "page",
    title: "Accounts",
    href: "/organize/accounts",
    who: ["admin"],
    answer:
      "Where an administrator makes a one-time password reset link for someone who lost their password; it works once, within a day. With email on (SMTP_URL set) the portal also mails it to the account's address; with email off, as out of the box, you hand it over yourself.",
    keywords: ["password reset", "forgot password", "lost password", "reset link", "accounts", "locked out", "reset email"],
    doc: { file: "docs/OPERATIONS.md", heading: "People and accounts" },
  },
  {
    id: "portal-log",
    kind: "page",
    title: "Portal log",
    href: "/organize/log",
    who: ["admin"],
    answer: "The audit entries no event owns: accounts made, sign-ins, API tokens, the signing key, demo mode and refusals outside any event. It is part of the same hash chain.",
    keywords: ["portal log", "sign in log", "account log", "admin log", "system log"],
    doc: { file: "docs/FEATURES.md", heading: "Audit log" },
  },
  {
    id: "api-tokens",
    kind: "page",
    title: "API tokens",
    href: "/account/tokens",
    who: ["signed-in"],
    answer:
      "Make a named token for scripts, sent as Authorization: Bearer <token>. It acts with your permissions, can be revoked, and cannot make more tokens.",
    keywords: ["api token", "api key", "bearer", "personal access token", "script", "automation", "revoke token"],
    doc: { file: "docs/FEATURES.md", heading: "API and webhooks" },
  },

  // ---- organizers: tasks --------------------------------------------------------------------------------------
  {
    id: "decisions",
    kind: "task",
    title: "Settle the decisions",
    href: "/organize/[event]",
    who: ["organizer"],
    answer:
      "The Overview lists what stands between the scores and the results (a flat judge, a duplicate entry, an under-reviewed project), each with its evidence and what it would move. Each choice is one audited action, with a written reason wherever it overrides a rule.",
    keywords: ["decisions", "settle", "open decisions", "blocked", "why can't i publish", "3 decisions", "needs you", "resolve"],
    doc: { file: "README.md", heading: "A guided tour" },
  },
  {
    id: "award-prizes",
    kind: "task",
    title: "Award the prizes",
    href: "/organize/[event]/results",
    who: ["organizer"],
    answer:
      "In the Prizes step at the foot of the Results tab, give each prize to a project, or to several jointly, with the places beside them and an optional note. Each save is logged; a prize can stay unawarded, and publishing makes the awards final.",
    keywords: ["award prize", "give a prize", "give the prize", "split a prize", "split a prize between projects", "split a prize between two projects", "joint prize", "share a prize", "prize winner", "prizes", "joint winner", "special award", "who gets the prize", "unawarded prize", "best in show"],
    doc: { file: "docs/FEATURES.md", heading: "Prizes" },
  },
  {
    id: "prizes",
    kind: "concept",
    title: "Prizes",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "The event's About page lists its prizes. The organizers give each prize on top of the places, before they publish. Once published, the results show each prize with its winners, and a winner's page and certificate say \"Winner, <prize>\".",
    keywords: ["prize", "prizes", "did we win a prize", "prize list", "award", "certificate prize", "winner of the prize"],
    doc: { file: "JUDGING.md", heading: "Prizes" },
  },
  {
    id: "publish",
    kind: "task",
    title: "Publish the results",
    href: "/organize/[event]",
    who: ["organizer"],
    answer:
      "On the Overview, once every decision is made and submissions are closed, tick the box and press Publish results. It makes the results page public, shows each team its feedback, closes an open vote and freezes the judging.",
    keywords: ["publish", "publish results", "release results", "announce winners", "make results public", "go live", "finish judging"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "invite-judges",
    kind: "task",
    title: "Invite judges",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "On Judges, make an invitation link for one judge (optionally tied to their email) or paste a list of names and addresses for one link each, and tick the tracks they judge. With email on (SMTP_URL set) the portal mails each invitation that has an address; with email off, as out of the box, you send the links yourself.",
    keywords: ["invite judge", "add judge", "judge link", "invitation", "bulk invite", "paste list", "judges email"],
    doc: { file: "docs/FEATURES.md", heading: "Judging" },
  },
  {
    id: "remind-judges",
    kind: "task",
    title: "Remind judges",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "On Judges, the Not started view lists the judges who have saved nothing yet, with a reminder to copy for each and for all. With email on (SMTP_URL set) it also has Email reminder and Email all, the same words, at most once an hour per judge.",
    keywords: ["remind judges", "reminder", "nudge judges", "judges not started", "chase judges", "email judges", "late judges"],
    doc: { file: "docs/FEATURES.md", heading: "Judging" },
  },
  {
    id: "reviews-per-project",
    kind: "task",
    title: "Judges per project",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "On Judges, the assignment form's Reviews per project (1 to 10, 3 unless the event already has its own number) sets how many judges review each project, all from the project's own track. A later top-up run fills the missing ones.",
    keywords: ["judges per project", "reviews per project", "how many judges", "how many reviews", "number of judges", "judges each project"],
    doc: { file: "JUDGING.md", heading: "Assignment" },
  },
  {
    id: "assignment",
    kind: "concept",
    title: "Assignment",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "Projects are given to judges by a seeded, stored run that never crosses tracks, keeps a judge off their own team's project and spreads the load; the same seed on the same data gives the same assignment. A top-up keeps every pair and fills only missing reviews.",
    keywords: ["assignment", "assign", "who judges what", "judge my own project", "judge my own team", "seed", "top-up", "reviews per project", "distribution", "bridge"],
    doc: { file: "JUDGING.md", heading: "Assignment" },
  },
  {
    id: "issue-records",
    kind: "task",
    title: "Issue certificates and records",
    href: "/organize/[event]/results",
    who: ["organizer"],
    answer:
      "Once results are published, \"Issue every record\" on Results gives each member of a submitting team a signed certificate and each judge with a finished review a signed judging record. People can also fetch their own from My project or the judge console.",
    keywords: ["certificates", "issue records", "issue every record", "diplomas", "awards", "certificate of achievement", "participation certificate"],
    doc: { file: "docs/FEATURES.md", heading: "Signed certificates and judging records" },
  },
  {
    id: "certificate",
    kind: "page",
    title: "A certificate or record",
    href: "/events/[event]/my-project",
    who: ["participant", "judge"],
    answer:
      "Each certificate and judging record has its own printable page, signed with the portal's Ed25519 key; the page checks its own signature in your browser. A team member gets theirs from My project after the results are published.",
    keywords: ["my certificate", "download certificate", "print certificate", "record page", "get certificate"],
    doc: { file: "docs/FEATURES.md", heading: "Signed certificates and judging records" },
  },
  {
    id: "exports",
    kind: "task",
    title: "Export data",
    href: "/organize/[event]/integrations",
    who: ["organizer"],
    answer:
      "Every stage exports as CSV (scores, projects, normalized ranking, audit log), and the whole event as event.json or fixtures.json: download them on the Overview or Integrations. Each is also an API route.",
    keywords: ["export", "download", "csv", "excel", "event.json", "fixtures.json", "scores.csv", "normalized.csv", "audit.csv", "spreadsheet", "backup data", "export results", "download results"],
    doc: { file: "docs/FEATURES.md", heading: "Import and export" },
  },
  {
    id: "imports",
    kind: "task",
    title: "Import an event",
    href: "/organize",
    who: ["admin"],
    answer:
      "On Your events, Import an event takes a file in the organizers' fixture format (the fixtures.json any event here exports). Importing the same file again changes nothing, and imported people get personal links on Integrations to set a password.",
    keywords: ["import", "bulk import", "fixtures.json", "upload event", "move event", "migrate", "load data", "fixture"],
    doc: { file: "docs/FEATURES.md", heading: "Import and export" },
  },
  {
    id: "webhooks",
    kind: "task",
    title: "Webhooks",
    href: "/organize/[event]/integrations",
    who: ["organizer"],
    answer:
      "On Integrations, add a URL and each audited action is POSTed to it as JSON, signed with an HMAC-SHA256 Dogfood-Signature header and retried with backoff, with a delivery log. The values of ballots, scores and pairwise answers stay in the portal.",
    keywords: ["webhook", "webhooks", "callback", "notify my server", "hmac", "signature header", "deliveries", "slack", "discord"],
    doc: { file: "docs/FEATURES.md", heading: "API and webhooks" },
  },
  {
    id: "embed",
    kind: "task",
    title: "Put the gallery on your site",
    href: "/organize/[event]/integrations",
    who: ["organizer"],
    answer: "Integrations gives a one-line script tag that embeds the event's gallery on another site; add data-track to show one track.",
    keywords: ["embed", "widget", "iframe", "our website", "put gallery on site", "embed.js", "script tag"],
  },
  {
    id: "switch-pairwise",
    kind: "task",
    title: "Switch judging to pairwise",
    href: "/organize/[event]/settings",
    who: ["organizer"],
    answer:
      "Settings, \"How judges judge\": choose Pairwise and give a reason. You can switch back until results are published, and scores given before the switch still count as the order they imply.",
    keywords: ["pairwise", "switch mode", "judging mode", "change to pairwise", "scores or pairwise", "how judges judge"],
    doc: { file: "docs/FEATURES.md", heading: "Pairwise judging (optional)" },
  },
  {
    id: "weights",
    kind: "task",
    title: "Change the rubric's weights",
    href: "/organize/[event]/settings",
    who: ["organizer"],
    answer:
      "Settings, \"Scoring rubric\". Once judges have scored, the criteria are fixed; a weight can still change with a written reason, and the published results show the weights before and after.",
    keywords: ["weights", "rubric", "criteria", "change weights", "scoring rubric", "weighted", "criterion weight"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "tie-break",
    kind: "task",
    title: "Break exact ties by a criterion",
    href: "/organize/[event]/settings",
    who: ["organizer"],
    answer:
      "Settings, \"Exact ties\": choose one rubric criterion, and projects in a track with exactly the same score are ordered by their average on it; tied on it too, they stay joint. The default keeps joint places. It needs a reason once judges have scored, is final once results are published, and does not apply to pairwise judging.",
    keywords: ["tie break", "tie-break", "tiebreak", "break ties", "exact tie", "same score", "joint place", "joint places", "tied projects", "tiebreaker"],
    doc: { file: "JUDGING.md", heading: "Breaking exact ties" },
  },
  {
    id: "joint-places",
    kind: "concept",
    title: "Joint places and \"tie broken by\"",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "Projects in one track with exactly the same score share a place (\"Joint 2nd\"), unless the organizers chose a criterion to break such ties before publishing: then the results, the project's page and its certificate say \"tie broken by\" that criterion.",
    keywords: ["joint", "joint 2nd", "shared place", "tie broken by", "why joint", "same place", "equal score", "tied"],
    doc: { file: "JUDGING.md", heading: "Breaking exact ties" },
  },
  {
    id: "become-organizer",
    kind: "task",
    title: "Become an organizer",
    href: null,
    who: ["everyone"],
    answer:
      "Make an account, then ask one of the event's organizers to add you: Settings, Organizers, by your account's email. A portal administrator who creates an event becomes its organizer.",
    keywords: ["become an organizer", "become organizer", "organizer role", "organizer access", "run an event", "make me an organizer"],
    doc: { file: "docs/OPERATIONS.md", heading: "People and accounts" },
  },
  {
    id: "co-organizers",
    kind: "task",
    title: "Add a co-organizer",
    href: "/organize/[event]/settings",
    who: ["organizer"],
    answer:
      "Settings, Organizers: add someone by the email of their account once they have signed up. Every organizer can change the event, settle its decisions and publish; the last one cannot be removed.",
    keywords: ["co-organizer", "add organizer", "another organizer", "colleague", "admin rights", "share event"],
    doc: { file: "docs/OPERATIONS.md", heading: "People and accounts" },
  },
  {
    id: "exclude-judge",
    kind: "task",
    title: "Reinstate or leave out a judge",
    href: "/organize/[event]/results",
    who: ["organizer"],
    answer:
      "From the judge's row in the judge ledger on Results (or the decision on the Overview), with a required reason, until results are published. The ledger shows what the change would move before you make it.",
    keywords: ["exclude judge", "reinstate judge", "override", "leave out judge", "bad judge", "count judge again", "remove scores"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "remove-judge",
    kind: "task",
    title: "Remove a judge",
    href: "/organize/[event]/judges",
    who: ["organizer"],
    answer:
      "On Judges, the judge's name opens their removal, with a reason, until results are published. Unstarted reviews are withdrawn; nothing they saved is deleted, but it leaves the ranking and the receipts name them as removed.",
    keywords: ["remove judge", "wrong account", "accepted by mistake", "invitation taken by the wrong person", "delete judge", "kick judge", "judge left"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "duplicates",
    kind: "concept",
    title: "Duplicate entries",
    href: "/organize/[event]",
    who: ["organizer"],
    answer:
      "A project entered twice is flagged on the Overview. Merging keeps one copy with both copies' reviews (a judge who scored both counts once), deletes no score, and can be undone until results are published.",
    keywords: ["duplicate", "entered twice", "same project twice", "merge", "copy", "double submission", "dry harbour"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "under-reviewed",
    kind: "concept",
    title: "Under-reviewed projects",
    href: "/organize/[event]",
    who: ["organizer"],
    answer:
      "A project with fewer than two counted reviews is flagged. The organizer tops up its reviews or publishes it as it is, with a reason, and the public results mark it under-reviewed.",
    keywords: ["under-reviewed", "one review", "only one review", "project with one review", "too few reviews", "not enough reviews", "small relay", "minimum reviews"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },

  // ---- ideas a judge of the portal asks about -------------------------------------------------------------------
  {
    id: "leniency",
    kind: "concept",
    title: "Leniency correction (normalization)",
    href: "/organize/[event]/results",
    who: ["everyone"],
    answer:
      "Before ranking, each judge's leniency (how far their scores sit from their co-reviewers') is estimated from the event's own scores, shrunk by n ÷ (n + k), and subtracted. With few reviews per judge it corrects little, by design, and every shift is on the receipts.",
    keywords: ["leniency", "normalization", "normalized", "lenient", "harsh", "strict judge", "generous judge", "bias", "evened out", "k", "shrinkage", "how are scores adjusted", "correction", "how projects are ranked", "fair ranking"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "plus-minus",
    kind: "concept",
    title: "The ± next to a score",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "The ± is one standard error of the score, from the same fit (on the sample event 0.66 with one counted review, 0.30 with five). Places whose scores sit within it of each other should be read as ties.",
    keywords: ["plus minus", "±", "error", "margin of error", "standard error", "uncertainty", "confidence", "ties", "how sure"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "flat-judge",
    kind: "concept",
    title: "The flat-judge rule",
    href: "/organize/[event]",
    who: ["everyone"],
    answer:
      "A judge with at least 3 finished reviews and the identical scores on every project (like 4 / 4 / 4 each time) is left out as a whole judge, with a visible flag and its reason. The organizer can reinstate them on the Overview, with a written reason.",
    keywords: ["flat judge", "4 4 4", "same scores", "identical scores", "left out", "excluded judge", "iva petrova", "who scored 4 4 4", "judge ignored"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "signal-check",
    kind: "concept",
    title: "The signal check",
    href: "/organize/[event]/results",
    who: ["everyone"],
    answer:
      "A permutation test: it shuffles the review totals 2,000 times and counts how often the shuffled projects spread as far apart as the real ones. A share near 0 means real differences; on the sample event it is about 0.76, so neighbouring places are close to ties.",
    keywords: ["signal check", "permutation", "permutation share", "significance", "is it random", "random", "is the ranking random", "chance", "luck", "noise", "p value"],
    doc: { file: "JUDGING.md", heading: "The finding on the sample event" },
  },
  {
    id: "judge-ledger",
    kind: "concept",
    title: "The judge ledger",
    href: "/organize/[event]/results",
    who: ["organizer"],
    answer:
      "On Results, every judge with a finished review: reviews counted, plain tilt, leniency ± error, and what leaving that judge out (or counting them again) would move, including any first place that changes.",
    keywords: ["judge ledger", "influence", "single judge influence", "what if", "leave one out", "judge table", "tilt"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "pairwise",
    kind: "concept",
    title: "Pairwise mode",
    href: "/organize/[event]/settings",
    who: ["everyone"],
    answer:
      "Instead of scoring, judges answer \"which is better?\" about two of their projects at a time; a Bradley-Terry fit of every answer ranks the projects, and each place carries its chance of really being ahead of the next.",
    keywords: ["pairwise", "bradley terry", "comparisons", "which is better", "head to head", "win percentage", "pairwise ranking"],
    doc: { file: "JUDGING.md", heading: "Pairwise mode" },
  },
  {
    id: "ranking-so-far",
    kind: "concept",
    title: "Your ranking so far",
    href: "/judge/[event]",
    who: ["judge", "organizer"],
    answer:
      "Under the rubric, the console lists the judge's own finished reviews by their totals, so a judge can calibrate against themselves. It uses only that judge's scores; an organizer can hide it in Settings, \"How judges judge\".",
    keywords: ["ranking so far", "my ranking", "own ranking", "calibrate", "compare against own totals", "my rank", "drift"],
    doc: { file: "JUDGING.md", heading: "Scoring" },
  },
  {
    id: "audit-chain",
    kind: "concept",
    title: "The audit chain and its head",
    href: "/organize/[event]/audit",
    who: ["everyone"],
    answer:
      "Each audit row carries the hash of the row before it, and the database refuses edits and deletes. Keep the head hash (on the Audit log tab and in audit.csv): if any row is later rewritten, the head no longer matches.",
    keywords: ["audit chain", "hash chain", "head hash", "tamper evident", "tamper", "append only", "integrity", "sha-256", "genesis"],
    doc: { file: "JUDGING.md", heading: "The audit trail" },
  },
  {
    id: "freeze",
    kind: "concept",
    title: "After the results: the freeze",
    href: "/events/[event]/results",
    who: ["everyone"],
    answer:
      "Publishing stores the exact run it publishes; from then on the database refuses to change a score or answer or to swap the results, and the rubric, dates, tracks and assignments are final too. Results cannot be unpublished.",
    keywords: ["freeze", "frozen", "unpublish", "change results", "final", "locked", "edit scores after"],
    doc: { file: "JUDGING.md", heading: "Normalization" },
  },
  {
    id: "demo-mode",
    kind: "concept",
    title: "Checker sessions and demo mode",
    href: "/sign-in",
    who: ["everyone"],
    answer:
      "With SEED_CHECKER_SESSIONS=true the portal seeds four sessions for the acceptance checker (organizer, judge A, judge B, participant) plus the one-click demo sign-ins; their tokens are public, so a real event turns it off.",
    keywords: ["demo mode", "checker sessions", "seed checker sessions", "test logins", "demo accounts", "cookie session", "run.py", "public tokens"],
    doc: { file: "docs/OPERATIONS.md", heading: "Demo mode off" },
  },
  {
    id: "backups",
    kind: "concept",
    title: "Backups",
    href: null,
    who: ["admin"],
    answer:
      "Run node scripts/backup.mjs inside the container: it copies the database and the uploaded pictures into a dated folder in the volume while the portal runs. Copy each backup off the machine; scripts/restore.mjs puts one back.",
    keywords: ["backup", "back up", "restore", "disaster", "save database", "snapshot", "sqlite backup"],
    doc: { file: "docs/OPERATIONS.md", heading: "Backup and restore" },
  },
  {
    id: "api",
    kind: "concept",
    title: "The API",
    href: "/api-docs",
    who: ["everyone"],
    answer:
      "Everything the interface does is also a JSON route through the same permission checks. Scripts use a named API token as Authorization: Bearer <token>; the reference is at /api-docs.",
    keywords: ["api", "rest api", "automate", "script", "json routes", "programmatic", "bearer token", "curl"],
    doc: { file: "docs/FEATURES.md", heading: "API and webhooks" },
  },
  {
    id: "rate-limits",
    kind: "concept",
    title: "Rate limits and abuse",
    href: "/organize/[event]/voting",
    who: ["everyone"],
    answer:
      "Ballots, open-link entries, comments and sign-ins are rate limited (429 with Retry-After), suspected duplicate ballots are flagged on the Voting tab for an audited set-aside, and every step is in the audit log.",
    keywords: ["rate limit", "429", "spam", "abuse", "too many requests", "ballot stuffing", "sybil", "fraud", "cheating"],
    doc: { file: "THREAT-MODEL.md", heading: "Ballot stuffing" },
  },
  {
    id: "refusals",
    kind: "concept",
    title: "Refusals (401 and 403)",
    href: null,
    who: ["everyone"],
    answer:
      "No or an invalid session answers 401; signed in without permission answers 403. They are real responses from the one permission check, never redirects, and a 403 to someone signed in is written to the audit log.",
    keywords: ["403", "401", "forbidden", "unauthorized", "access denied", "not allowed", "permission", "refused"],
    doc: { file: "ARCHITECTURE.md", heading: "A request's path" },
  },
  {
    id: "run-it",
    kind: "concept",
    title: "Running the portal",
    href: null,
    who: ["everyone"],
    answer:
      "docker compose up gives a seeded portal on localhost:8080 with no network at run time; docker compose down -v resets everything. For a real event, turn demo mode off and set your own secret, as the README says.",
    keywords: ["install", "docker", "self host", "run locally", "deploy", "setup", "docker compose", "reset", "offline", "hosting"],
    doc: { file: "README.md", heading: "Run it" },
  },
];

/** The top-level places offered when nothing matches. */
export const HELP_PLACES: Record<"everyone" | HelpRole, string[]> = {
  everyone: ["gallery", "results-public", "about", "sign-in", "verify"],
  participant: ["my-project", "gallery", "vote", "results-public"],
  judge: ["judge-console", "gallery", "results-public"],
  organizer: ["overview", "results-organizer", "judges-tab", "audit-tab", "settings"],
  admin: ["your-events", "new-event", "accounts", "portal-log"],
};

/** Questions offered when the panel opens, by role; each is tested to find its entry first. */
export const HELP_SUGGESTIONS: Record<"visitor" | HelpRole, { q: string; expect: string }[]> = {
  visitor: [
    { q: "How do I sign in to the demo?", expect: "sign-in" },
    { q: "How are harsh and generous judges evened out?", expect: "leniency" },
    { q: "What does the ± next to a score mean?", expect: "plus-minus" },
    { q: "How do I check a certificate?", expect: "verify" },
  ],
  participant: [
    { q: "How do I hand in my project?", expect: "hand-in" },
    { q: "Where do I see my reviews?", expect: "my-feedback" },
    { q: "How do I vote?", expect: "vote" },
    { q: "How do I get my certificate?", expect: "certificate" },
  ],
  judge: [
    { q: "How do I score with the keyboard?", expect: "judge-keys" },
    { q: "Can I see other judges' scores?", expect: "other-judges" },
    { q: "How do I declare a conflict of interest?", expect: "conflict" },
    { q: "What is leniency correction?", expect: "leniency" },
  ],
  organizer: [
    { q: "How do I publish the results?", expect: "publish" },
    { q: "Why is a judge left out?", expect: "flat-judge" },
    { q: "What does the ± mean?", expect: "plus-minus" },
    { q: "Where is the audit log?", expect: "audit-tab" },
    { q: "How do I invite judges?", expect: "invite-judges" },
  ],
  admin: [
    { q: "How do I create a new event?", expect: "new-event" },
    { q: "How do I import an event?", expect: "imports" },
    { q: "How do I reset someone's password?", expect: "accounts" },
  ],
};

/** Up to five suggestions for this person: their strongest role first. */
export function suggestionsFor(viewer: Pick<HelpViewer, "signedIn" | "roles">): string[] {
  const order: HelpRole[] = ["organizer", "judge", "participant", "admin"];
  const roles = order.filter((r) => viewer.roles.includes(r));
  const lists = roles.length ? roles.map((r) => HELP_SUGGESTIONS[r]) : [HELP_SUGGESTIONS.visitor];
  // one from each role in turn, so someone who judges and organizes sees both
  const out: string[] = [];
  for (let i = 0; out.length < 5 && lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && out.length < 5 && !out.includes(l[i]!.q)) out.push(l[i]!.q);
  return out;
}

const AUDIENCE_LABEL: Record<HelpAudience, string> = {
  everyone: "Everyone",
  "signed-in": "Anyone signed in",
  participant: "Team members",
  judge: "Judges",
  organizer: "Organizers",
  admin: "Administrators",
};

/** "Organizers", "Judges and organizers", "Everyone"; anyone signed in covers the roles beside it. */
export function audienceLabel(who: HelpAudience[]): string {
  if (who.includes("everyone")) return AUDIENCE_LABEL.everyone;
  if (who.includes("signed-in")) return AUDIENCE_LABEL["signed-in"];
  return joinNames(who.map((w) => AUDIENCE_LABEL[w]));
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)!.toLowerCase()}`;
}

/**
 * How near this person is to what an entry describes: 0, they can do it; 1, they could once signed in (a visitor,
 * for what any account can do); 2, it is for a role they do not hold. The panel ranks by it, then by the text.
 */
export function reach(entry: Pick<HelpEntry, "who">, viewer: Pick<HelpViewer, "signedIn" | "roles">): 0 | 1 | 2 {
  if (canUse(entry, viewer)) return 0;
  if (!viewer.signedIn && entry.who.includes("signed-in")) return 1;
  return 2;
}

/**
 * The line over an answer, for this person: who it is for when they can use it ("Everyone", "Organizers"), "Sign
 * in to do this" when an account is all they lack, and else whose it is ("Organizers only", "Judges and organizers
 * only").
 */
export function accessLabel(entry: Pick<HelpEntry, "who">, viewer: Pick<HelpViewer, "signedIn" | "roles">): string {
  const r = reach(entry, viewer);
  if (r === 0) return audienceLabel(entry.who);
  if (r === 1) return "Sign in to do this";
  return `${joinNames(entry.who.filter((w) => w !== "signed-in").map((w) => AUDIENCE_LABEL[w]))} only`;
}

/** Whether this person can use what the entry describes (an administrator sees every event as its organizers do). */
export function canUse(entry: Pick<HelpEntry, "who">, viewer: Pick<HelpViewer, "signedIn" | "roles">): boolean {
  return entry.who.some(
    (w) =>
      w === "everyone" ||
      (w === "signed-in" && viewer.signedIn) ||
      (w !== "signed-in" && viewer.roles.includes(w)) ||
      (w === "organizer" && viewer.roles.includes("admin")),
  );
}

/** The entry's link for the event in view; null when it has none, or names an event and none is known. */
export function resolveHref(entry: HelpEntry, event: HelpViewer["event"]): string | null {
  if (!entry.href) return null;
  if (!entry.href.includes("[")) return entry.href;
  if (!event) return null;
  const filled = entry.href.replace("[event]", encodeURIComponent(event.slug));
  return filled.includes("[") ? null : filled;
}

export type HelpMatch = { entry: HelpEntry; usable: boolean; score: number };
export type HelpAnswer = { question: string; matches: HelpMatch[]; places: HelpEntry[] };

// built on the first question, not on every page load
let matcher: Matcher | null = null;
const guide = () => (matcher ??= buildMatcher(HELP_ENTRIES.map((e) => ({ id: e.id, title: e.title, keywords: e.keywords, answer: e.answer }))));
const byId = new Map(HELP_ENTRIES.map((e) => [e.id, e]));

export function helpEntry(id: string): HelpEntry | undefined {
  return byId.get(id);
}

/** Matches within this share of the best text score, covering as much of the question, are close: among them, what
 *  the person can do ranks first. Narrow on purpose: a strong match the reader cannot use stays above weak ones they
 *  can ("how many judges per project" is the organizers' Judges per project, also for a judge). */
export const CLOSE_SHARE = 0.8;

/**
 * The best one to three entries for a question. The text decides what matches: an entry must clear the floors
 * (./match.ts: enough of the rarer words, at least 60 % of the words, a score over MATCH_FLOOR) and reach
 * RELATIVE_FLOOR of the best text score. Among the close matches (CLOSE_SHARE of the best),
 * what this person can do comes first, then what they could do once signed in, then what is someone else's
 * (reach), each group best text first; a weaker match never jumps a much better one. None when nothing clears the
 * floors, and then `places` holds the top-level places to offer instead.
 */
export function ask(question: string, viewer: Pick<HelpViewer, "signedIn" | "roles">): HelpAnswer {
  const scored = guide()
    .score(question)
    .filter((m) => m.coverage >= COVERAGE_FLOOR && m.wordShare >= WORD_SHARE_FLOOR && m.score >= MATCH_FLOOR);
  const best = scored[0];
  if (!best) return { question, matches: [], places: placesFor(viewer) };
  const matches = scored
    .filter((m) => m.score >= best.score * RELATIVE_FLOOR)
    .map(({ id, score, coverage, wordShare }) => {
      const entry = byId.get(id)!;
      // close: nearly as good a text match as the best, answering as much of the question
      const close = score >= best.score * CLOSE_SHARE && coverage >= best.coverage - 1e-9 && wordShare >= best.wordShare;
      // an account is a click away: for a visitor, what any account can do counts as theirs
      const near = reach(entry, viewer);
      return { entry, near, score, group: close ? (near === 2 ? 1 : 0) : 2 };
    })
    .sort((a, b) => a.group - b.group || b.score - a.score)
    .slice(0, 3)
    .map(({ entry, near, score }) => ({ entry, usable: near === 0, score }));
  return { question, matches, places: [] };
}

/** The top-level places for this person: their own first, then everyone's. */
export function placesFor(viewer: Pick<HelpViewer, "signedIn" | "roles">): HelpEntry[] {
  const order: HelpRole[] = ["organizer", "judge", "participant", "admin"];
  const ids = [...order.filter((r) => viewer.roles.includes(r)).flatMap((r) => HELP_PLACES[r]), ...HELP_PLACES.everyone];
  return [...new Set(ids)].slice(0, 6).map((id) => byId.get(id)!);
}
