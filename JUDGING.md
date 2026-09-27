# How judging works

This document states how the portal turns judge scores into results, and defends the choices with measurements. The scores pass through three steps: assignment of projects to judges, scoring against the organizer's rubric, and normalization, which estimates each judge's leniency from the event's own scores and subtracts it. It also states what the engine does not do and where the audit trail stops.

The evidence is checkable. `tests/normalization-mc.test.ts` builds simulated events on the sample event's own 126 judge–project pairs and scores the engine against the raw mean; `tests/normalize-oracle.test.ts` checks the fit against the planning run's numbers and against planted leniency; `tests/normalize-errors.test.ts` checks the ± on every score by simulation; `tests/judge-ledger.test.ts` holds the single-judge influence check to what an override then does; the organizers' acceptance suite re-checks the score-refusal rule. On a running instance the organizer can export `normalized.csv`, `audit.csv` and `event.json`. Every number below about the sample event is recomputable from those exports. Where each feature beyond the organizers' checker stands (community voting and the rest of T3, and T4) is in the README's "Beyond the checker" table, with the hand-check output in `isolation-report.txt`.

## The finding on the sample event

The sample event (`fixtures.json`) has 41 projects and 126 finished reviews. Four findings drive the design.

**One flat judge matters.** Judge Iva Petrova (jdg_07) scored all 3 assigned projects 4 / 4 / 4 — the identical vector on every project, so those reviews rank nothing. The flat-judge rule leaves Iva Petrova out as a whole judge, with a visible flag and its reason. That exclusion alone moves 19 of 41 projects by at least one place; the largest move is Small Relay (prj_19), 14th to 30th.

**Why little else moves.** The estimated leniency is about 2 % of judge disagreement: β̂² = 0.0100 against σ̂² = 0.4276, so the engine keeps from 2 % (a judge with one review) to 21 % (a judge with eleven) of a judge's own tilt, and no kept judge's leniency exceeds 0.062 in size. The signal check — a permutation test that shuffles the review totals and counts how often the shuffled project means spread at least as far as the real ones — finds no project differences beyond chance: permutation share 0.7645 (1,529 of 2,000 shuffles), where a share near 0 would mean real differences. Its positive control, planted project differences, is detected. On this event the engine's job is not to change the ranking; it is to bound and disclose what bias could have done.

| Rank | Project | Track | Reviews counted | Raw, all judges (rank) | Raw, without flat judge (rank) | Normalized | Move, raw → normalized |
|---|---|---|---|---|---|---|---|
| 1 | Iron Switch (prj_34) | Open hardware | 3 | 4.33 (1.5) | 4.33 (1.5) | 4.33 | – |
| 2 | Salt Ledger (prj_11) | Data and analytics | 4 | 4.33 (1.5) | 4.33 (1.5) | 4.33 | – |
| 3 | Still Beacon (prj_10) | Open hardware | 2 | 4.17 (3) | 4.17 (3) | 4.14 | – |
| 4 | Dry Relay (prj_25) | Data and analytics | 3 | 4.11 (4) | 4.11 (4) | 4.12 | – |
| 5 | Salt Loom (prj_37) | Education | 4 | 4.08 (5) | 4.08 (5) | 4.08 | – |
| 6 | Salt Kiln (prj_16) | Security | 3 | 4.00 (6.5) | 4.00 (6.5) | 4.00 | – |
| 7 | Slow Trail (prj_33) | Developer tools | 3 | 4.00 (6.5) | 4.00 (6.5) | 3.99 | – |
| 8 | Copper Kiln (prj_21) | Data and analytics | 3 | 3.89 (8) | 3.89 (8) | 3.89 | – |
| 9 | Dry Harbour (prj_41) | Accessibility | 4 | 3.83 (9) | 3.83 (9) | 3.82 | – |
| 10 | North Drift (prj_08) | Security | 5 | 3.80 (10) | 3.80 (10) | 3.80 | – |
| 11 | Deep Beacon (prj_38) | Data and analytics | 3 | 3.78 (11.5) | 3.78 (11.5) | 3.79 | – |
| 12 | Green Switch (prj_04) | Education | 3 | 3.78 (11.5) | 3.78 (11.5) | 3.77 | – |
| 13 | Copper Orbit (prj_15) | Security | 2 | 3.67 (14) | 3.67 (13.5) | 3.67 | +1 |
| 14 | Salt Drift (prj_36) | Open hardware | 3 | 3.67 (14) | 3.67 (13.5) | 3.66 | – |
| 15 | Salt Ferry (prj_31) | Developer tools | 3 | 3.56 (17.5) | 3.56 (15.5) | 3.55 | +2.5 |
| 16 | Small Meadow (prj_02) | Accessibility | 3 | 3.56 (17.5) | 3.56 (15.5) | 3.53 | +1.5 |
| 17 | Open Kiln (prj_18) | Education | 2 | 3.50 (21) | 3.50 (18) | 3.51 | +4 |
| 18 | Glass Beacon (prj_24) | Accessibility | 2 | 3.50 (21) | 3.50 (18) | 3.51 | +3 |
| 19 | Paper Anchor (prj_39) | Accessibility | 2 | 3.50 (21) | 3.50 (18) | 3.48 | +2 |
| 20 | Warm Beacon (prj_35) | Climate | 5 | 3.47 (23) | 3.47 (20) | 3.46 | +3 |
| 21 | Open Beacon (prj_12) | Education | 3 | 3.44 (26) | 3.44 (23) | 3.45 | +5 |
| 22 | Glass Signal (prj_01) | Security | 3 | 3.44 (26) | 3.44 (23) | 3.45 | +4 |
| 23 | Flat Thread (prj_27) | Open hardware | 3 | 3.44 (26) | 3.44 (23) | 3.44 | +3 |
| 24 | Loud Ledger (prj_32) | Developer tools | 3 | 3.44 (26) | 3.44 (23) | 3.44 | +2 |
| 25 | Flat Meadow (prj_28) | Data and analytics | 3 | 3.44 (26) | 3.44 (23) | 3.42 | +1 |
| 26 | Green Lantern (prj_14) | Education | 5 | 3.40 (29) | 3.40 (26) | 3.40 | +3 |
| 27 | Flat Relay (prj_29) | Developer tools | 2 | 3.33 (31.5) | 3.33 (30) | 3.34 | +4.5 |
| 28.5 | Hollow Signal (prj_09) | Health | 2 of 3 | 3.56 (17.5) | 3.33 (30) | 3.34 | -11 |
| 28.5 | Small Loom (prj_17) | Health | 2 of 3 | 3.56 (17.5) | 3.33 (30) | 3.34 | -11 |
| 30 | Small Relay (prj_19) | Health | 1 of 2 | 3.67 (14) | 3.33 (30) | 3.33 | -16 |
| 31 | Dry Harbour (prj_07) | Accessibility | 5 | 3.33 (31.5) | 3.33 (30) | 3.33 | – |
| 32 | Quiet Anchor (prj_13) | Climate | 3 | 3.33 (31.5) | 3.33 (30) | 3.33 | – |
| 33 | Deep Compass (prj_03) | Accessibility | 3 | 3.33 (31.5) | 3.33 (30) | 3.32 | -1.5 |
| 34 | Paper Thread (prj_20) | Open hardware | 3 | 3.22 (34.5) | 3.22 (34.5) | 3.22 | – |
| 35 | Amber Hours (prj_26) | Climate | 3 | 3.22 (34.5) | 3.22 (34.5) | 3.21 | – |
| 36 | Paper Harbour (prj_30) | Education | 3 | 3.11 (37) | 3.11 (37) | 3.12 | +1 |
| 37 | Dry Bridge (prj_22) | Security | 3 | 3.11 (37) | 3.11 (37) | 3.12 | – |
| 38 | Dry Compass (prj_06) | Developer tools | 3 | 3.11 (37) | 3.11 (37) | 3.10 | -1 |
| 39 | Slow Loom (prj_40) | Developer tools | 2 | 3.00 (39) | 3.00 (39) | 2.99 | – |
| 40 | North Compass (prj_05) | Data and analytics | 3 | 2.89 (40.5) | 2.89 (40.5) | 2.89 | – |
| 41 | Slow Quarry (prj_23) | Open hardware | 3 | 2.89 (40.5) | 2.89 (40.5) | 2.88 | – |

The last column is the change from the rank on the raw mean with every judge to the normalized rank: the flat judge's exclusion and the leniency correction together. The exclusion alone is the paragraph above; ranks are average ranks, so a project in a three-way tie at 3.11 holds 37.

**The duplicate is the measured noise floor.** The same project entered twice by team CopperLedger as "Dry Harbour" (prj_07 and prj_41) ranks 31.5th and 9th of 41 unmerged on raw means; merged, it ranks 22nd of 40 after normalization (25.5th on the raw mean). Consequence: read neighbouring ranks as ties; the public results page shows scores next to places.

**One judge can move many places.** The single-judge influence check reruns the whole engine with one judge's status flipped. Leaving out any one of the 29 counted judges moves between 3 and 34 of the 41 projects by a place or more (median 20), and for 11 of them some track's first place changes. It is the signal check's finding seen from the judges' side: on scores this close, one review in three decides places. The organizer sees this for every judge in the judge ledger before making any override, and each score carries its ± (0.38 for a project with three counted reviews), so neighbouring places read as ties.

## Assignment

A fresh run starts with a bridge pre-pass: every judge with two or more tracks gets `bridgePerTrack` projects, default 2, in each of its tracks, fewest seats filled first. Then a greedy pass picks the most constrained open project (fewest spare eligible judges) and gives it the least-loaded eligible judge from its own track; ties are broken by a seeded random draw. The seed and every parameter are stored with the run, and the same seed on the same data gives the same assignment (tested). A top-up run keeps every existing pair and fills only missing reviews.

Conflicts: a judge on a project's team never gets it; a judge assigned to a project cannot join its team afterwards (403 `conflict_of_interest`) unless they first declare the conflict; and a judge can declare a conflict of interest, which removes the assignment from the engine. The engine never assigns across tracks. A project with fewer than two eligible judges in its track is flagged under-reviewed, and only an organizer can give it a judge by hand, with a reason that goes into the audit log. Each judge's projects come in a seeded random order, so no project is always read first or last.

Why bridges: normalized ranks compare within a track; tracks compare only through judges who score in both.

## Scoring

The organizer defines the rubric: criteria with weights (the sample event uses equal weights), each scored on the criterion's scale (1 to 5 here). A review's total is Σ weight × score ÷ Σ weight, and the judge sees the formula filled in. A review counts only when every criterion is scored; a missing criterion is stored as absent, never as zero, and the review is shown as unfinished.

Judges see only their own scores ("your ranking so far" lists their own finished reviews); the server refuses any other judge's scores with 403 (tested, and checked by the organizers' own acceptance suite). Scoring closes when judging closes or when results are published.

## Normalization

Each counted review's weighted total y = project level + judge leniency + noise. Project levels are not shrunk: a project with fewer reviews is never pulled to the middle for it. Each judge's leniency is shrunk by n ÷ (n + k), with k = σ̂² ÷ β̂² estimated from the event's own scores on every run. In plain words: each judge's deviations from the other reviewers of the same projects are compared with each other; if they lean the same way across projects more than chance allows, the judge has a leniency, and pairs of projects that share reviewers count for less because their deviations agree partly by construction. The estimator: d is a review minus the mean of the other reviews of the same project; for each judge with two or more such deviations, C = Σ over pairs of their deviations d_r × d_s ÷ Σ over the same pairs [1 + shared ÷ ((m_r − 1)(m_s − 1))], where shared is the number of other judges who reviewed both projects and m is the reviews per project; β̂² = max(0, Σ (n_j − 1) C_j ÷ Σ (n_j − 1)); W is the pooled within-project variance and σ̂² = max(0.05, W − β̂²). If β̂² is 0, no leniency is corrected and each project's score is its plain mean. The fit solves the normal equations directly. The project levels, which are not shrunk, are eliminated exactly first, which leaves one system with a row per judge, solved by one Cholesky; the full system and an alternating solver reach the same answer to within 1e-10 and 1e-11 (tested). So the cost grows with the number of judges, not projects: on a simulated event of 1,000 projects and 150 judges one fit with its errors takes about 25 ms, and the judge ledger's 150 reruns about 1.4 s (`tests/normalize-scale.test.ts` prints these on the machine that built this; the test asserts only a loose ceiling, since timings vary by machine). On the fixture: W = 0.4376, β̂² = 0.0100, σ̂² = 0.4276, k = 42.59, so a judge needs about 43 reviews before half their tilt counts; no kept judge's leniency exceeds 0.062 in size. A project's normalized score is exactly the mean of its reviews after each judge's leniency is subtracted, and the organizer's results page shows that receipt for every project, with the change from the raw mean split into what leaving judges out did and what the leniency correction did.

Each score and each fitted leniency carries a ± of one standard error from the same fit: √(σ̂² × that estimate's entry on the diagonal of the inverse of the matrix the fit solves). It counts both the ordinary scatter of the reviews and the extra doubt from having to estimate each judge's leniency from those same reviews (in statistics terms, the mixed-model equations with the leniencies as the random part), so a score's ± is never below σ̂ ÷ √n. On the fixture a score's ± is 0.66 with one counted review, 0.47 with two, 0.38 with three, 0.33 with four and 0.30 with five. Every kept judge's leniency carries ±0.09 to ±0.10, against at most 0.062 of leniency: no single judge's leniency stands out from its own ±, though the panel as a whole shows some, which is what β̂² = 0.0100 measures. A judge's ± is shown only when leniency is fitted (β̂² > 0). When no project has two counted reviews, nothing measures the review noise (W has no data), so no ± is shown at all: the 0.05 floor alone would pose as a measurement. The scores are computed as usual. Publishing stores each score's ± with the run, and the public results page and each team's own page show it next to the score.

The judge ledger, on the organizer's results page, lists every judge with a finished review: reviews counted, plain tilt, leniency ± error, the share of the tilt the engine keeps, any flag or override, and the single-judge influence check. The check reruns the whole engine with that judge's status flipped (left out if counted, counted again if left out) and reports how many projects move a place or more, the largest move, and any track whose first place changes. The override is made from the same row, with a required reason, until results are published. On the fixture, a test flips every judge in turn and checks that the override moves as many projects as the check predicted, with the same largest move and the same changes of first place.

The flat-judge rule: a judge with at least 3 finished reviews and the identical score vector on every project is left out as a whole judge, with a visible flag and its reason. In simulation the rule flags an honest judge in 7.7 % (no bias), 8.0 % (moderate bias) and 6.2 % (moderate bias, noisy judges) of 1,000 panels on the fixture's pairs. That is why it is a reversible flag and never a silent deletion: the organizer can reinstate a flagged judge or exclude any judge, only with a written reason, and can undo either. Every override is audited and stored with the run.

Duplicates: the organizer can merge two copies. The kept copy inherits the other's reviews, a judge who scored both counts once (their average), no score is deleted, and which copy is kept does not change the merged result (tested). A project left with fewer than 2 counted reviews is flagged under-reviewed; the organizer can top up its reviews or publish it as it is, marked under-reviewed on the public results. Until the results are published, each of these decisions can be undone from the overview, and the undo is logged like the decision. Publishing is refused while submissions are still open (a project sent later would be missing from the results) and while any of these decisions is open, and it stores the exact run it publishes. After publishing, the scoring rubric, the event's dates and the judge assignments are final too (409), so every live view, export and judge's console keeps matching what was published.

## Validation

The Monte Carlo (`tests/normalization-mc.test.ts`): 1,000 fixed-seed runs per scenario on the fixture's own 126 judge–project pairs. Each run draws true project qualities, judge offsets and scales and review noise, rounds and clips to 1–5, and keeps the flat judge's real 4 / 4 / 4. Methods: the raw mean; the engine at k = 3 (the earlier default, kept as the comparison row); the engine with k estimated (what ships). Score: Kendall tau-b against the truth, over pairs in the same track and over all pairs. 1,000 runs per scenario, seed 20260923:

| scenario | method | within-track tau | pooled tau |
|---|---|---|---|
| no-bias control | raw | 0.917 (sd 0.042) | 0.892 (sd 0.026) |
| no-bias control | k = 3 | 0.909 (sd 0.045) | 0.905 (sd 0.022) |
| no-bias control | engine | 0.914 (sd 0.044) | 0.911 (sd 0.022) |
| moderate bias | raw | 0.880 (sd 0.050) | 0.817 (sd 0.042) |
| moderate bias | k = 3 | 0.895 (sd 0.047) | 0.849 (sd 0.035) |
| moderate bias | engine | 0.899 (sd 0.045) | 0.858 (sd 0.033) |
| moderate bias, noisy judges | raw | 0.754 (sd 0.078) | 0.722 (sd 0.053) |
| moderate bias, noisy judges | k = 3 | 0.756 (sd 0.077) | 0.733 (sd 0.050) |
| moderate bias, noisy judges | engine | 0.756 (sd 0.077) | 0.732 (sd 0.050) |
| batch confound (known-bad for leniency) | raw | 0.800 (sd 0.070) | 0.794 (sd 0.053) |
| batch confound (known-bad for leniency) | k = 3 | 0.833 (sd 0.062) | 0.843 (sd 0.040) |
| batch confound (known-bad for leniency) | engine | 0.842 (sd 0.060) | 0.856 (sd 0.037) |

The test enforces three assertions, with margins declared before the run: (1) with no bias, the engine loses to the raw mean by no more than the run-to-run spread of the difference, within-track and pooled; (2) in the batch-confound case — a harsh judge given a genuinely stronger batch, a lenient judge a weaker one, the case a leniency model can get wrong — the engine's pooled tau is not below the raw mean's; (3) with moderate bias, with and without noisy judges, it trails k = 3 by no more than 0.010 within-track and 0.020 pooled. Its known-bad: an engine fed shifted project ids fails assertion (1) (mean within-track difference −0.961). The engine's own self-test: planted leniency is recovered (`tests/normalize-oracle.test.ts`), and with none planted β̂² comes out at 0.0000.

The ± (`tests/normalize-errors.test.ts`) is checked on simulated events of 40 projects and 12 judges, with three reviews per project and 1,500 events per setting. With the variances known, 95 % intervals built from it cover the true project levels between 94 % and 96 % of the time (asserted), and the true leniencies between 93 % and 97 %. That holds for strong leniency (k = 1.6) and for the fixture's size of leniency (k = 43). With the variances estimated from each event's own scores, as the portal runs, the intervals cover projects 94.5 % (strong) and 94.4 % (fixture-like) of the time. They cover judges 93.0 % and 93.2 % of the time in the events where leniency is fitted: slightly short, because the two variances are themselves estimated from the same event's scores and that extra wobble is not in the ±. Its known-bad: a halved or a doubled ± fails the same check.

## The audit trail

Every change and every refused request is written in the same database transaction as the change. Triggers refuse UPDATE and DELETE on the log, and they are re-created at every start. Each row carries the hash of the row before it. The organizer's audit page and `audit.csv` show the head hash. Limits, stated plainly: the triggers stop the application, not someone holding the database file; the chain is tamper-evident only against a head hash you kept outside the portal.

## Threat model

### Sybil votes

**What is built:** the organizer chooses who may vote in the community vote, per event: signed-in accounts (one ballot per account), people on a voter list (one personal link per address, made by the organizer), and anyone holding the event's open link (one ballot per browser). Opening a voting link only shows a page; entering takes a click, so link previews and mail scanners that fetch the URL never create a ballot. New open-link voters are limited to 8 per network address per hour. Ballots that come from the same network address and browser are flagged to the organizer as suspected duplicates; while voting is open, the organizer can set one aside, only with a written reason, and undo it; both are audited. Once the window closes the count is public, and final: the window can no longer move (which would hide the count again and let more ballots in), no ballot can be set aside or restored, and no new links are made (409 `voting_closed`); nobody new enters through the open link (403, like a late ballot).

**What is not:** proof that an open-link voter is one person. Clearing cookies, another browser or another network makes a new voter; the flags catch only the careless case, and people behind one shared address (an office, a venue's wifi) are flagged together, which is why the flag is a prompt for a human and never an automatic removal. Accounts are not email-verified (the portal sends no email), so the account mode is only as strong as sign-up. The network address the entry limit and the flags use is the `X-Forwarded-For` header, which a client talking to the portal directly can set itself; put the portal behind a reverse proxy that overwrites it.

### Ballot stuffing

**What is built:** each voter picks at most the organizer's number of favourites (3 by default), only among the event's submitted projects, and can change the picks while the window is open; the server checks all of it. Nobody known can vote for their own team's project (422): not a signed-in person, whichever way they vote, and not a voter-list link whose address is a team member's account; their ballot says so instead of offering the button. The count applies the same rules when it is made: a vote for a project whose team the voter joined afterwards does not count, and a vote on a copy the organizer merged counts for the copy it was merged into, once per voter (undoing the merge gives each copy its votes back). Saving a ballot is limited to 30 times a minute per voter (429 with `Retry-After`; the first refusal is audited). Every ballot change is audited with the picks before and after. Each ballot lists the projects in the voter's own seeded order, so no project gets the top spot on every ballot. The count is hidden from everyone, organizers included, until the window closes, so there is no running total to chase; for the same reason the audit log page and its CSV show that a ballot changed but not what it holds until then (the rows are stored and hashed in full from the start), and a webhook for a ballot change never carries the picks, since it goes out while voting is open.

**What is not:** a CAPTCHA or any browser fingerprint beyond the address and the user agent; and a signed-out voter on the open link cannot be matched to a team, so the own-project rule holds only for people it can name: someone signed in, or a voter-list address that belongs to an account. A merge can also join copies from two teams; the rule then follows the kept copy's team.

### Submission scraping

**What is built:** drafts are private, and the gallery and the API show only submitted projects. Comments need an account and are limited to 5 per 10 minutes per account.

**What is not:** a rate limit on reading. A client can read the public pages and API as fast as it likes; what it gets is what the event made public.

### Judge collusion

**What is built:** judges cannot read each other's scores (backend-enforced, tested, and checked by the organizers' suite); every score change is audited with before and after; the leniency model limits what one generous or harsh judge can do; the flat-judge rule catches a judge who scores everything the same; the judge ledger shows, for every judge, what leaving them out would move.

**What is not:** detection of coordinated collusion. Two judges trading favourable scores look like ordinary disagreement to the model; nothing flags that. The audit log keeps the evidence for an organizer to read.

### Deadline gaming

**What is built:** the submission deadline and the voting window are enforced on the server: exclusive close times, refusals with 403, audited. A late duplicate submission is handled by the merge decision. Password sign-in is limited to 10 attempts per email address per 15 minutes, and sign-ups and sign-ins together to 60 per network address per 10 minutes, since each one costs a password hash.

**What is not:** a grace period. The close time is exclusive by design: a submission or vote before it counts, one at or after it does not.

### Requests forged by another page

**What is built:** the session cookie is `HttpOnly` and `SameSite=Lax`, so a page on another site cannot make a visitor's browser send it with a write. A page on the same site but another origin (another app on the same host, a sibling subdomain) can, and the API reads a JSON body whatever type it declares, which lets such a page send a write that needs no CORS preflight. So an API write that the browser marks as coming from another origin (`Sec-Fetch-Site`, or `Origin` checked against the host for browsers that lack it) arrives without its cookies (`src/proxy.ts`): signed out, answered 401 like any anonymous call. Requests without those browser headers (curl, scripts, the organizers' checker) and Bearer tokens pass as they are. The portal's own forms post to Next's server actions, which check the origin themselves, or to this API (Sign out), which the same rule covers.

**What is not:** a guard on the two writes that need no session and set a cookie. Such a page could sign a visitor in to an account its owner controls (the API's sign-in), or enter an open voting link in the visitor's browser (a voter row with no ballot, since the ballot itself is a write that arrives signed out; the entry limit of 8 per address per hour applies). Keep apps you do not trust off the portal's host and its parent domain.

## What it does not do

No calibrated prize probabilities or rank intervals: each score carries a ± of one standard error, and the portal does not turn it into rank intervals or prize odds. A method that produced them was tried in planning and cut: on simulated events with no real differences it named a 50 %+ favourite in 46 of 80 tracks (planning simulation of 2026-09-24, not re-run in this repository). Places are decided within a track; the overall ranking (the organizer's table, and the table above) is a convenience view, since tracks compare only through judges who score in both, so read the order across tracks loosely. With few reviews per judge the engine corrects little, by design. No automatic cross-track assignment.
