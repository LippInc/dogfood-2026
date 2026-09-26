# How judging works

This document states how the portal turns judge scores into results, and defends the choices with measurements. The scores pass through three steps: assignment of projects to judges, scoring against the organizer's rubric, and normalization, which estimates each judge's leniency from the event's own scores and subtracts it. It also states what the engine does not do and where the audit trail stops.

The evidence is checkable. `tests/normalization-mc.test.ts` builds simulated events on the sample event's own 126 judge–project pairs and scores the engine against the raw mean; `tests/normalize-oracle.test.ts` checks the fit against the planning run's numbers and against planted leniency; the organizers' acceptance suite re-checks the score-refusal rule. On a running instance the organizer can export `normalized.csv`, `audit.csv` and `event.json`. Every number below about the sample event is recomputable from those exports.

## The finding on the sample event

The sample event (`fixtures.json`) has 41 projects and 126 finished reviews. Three findings drive the design.

**One flat judge matters.** Judge Iva Petrova (jdg_07) scored all 3 assigned projects 4 / 4 / 4 — the identical vector on every project, so those reviews rank nothing. The flat-judge rule leaves Iva Petrova out as a whole judge, with a visible flag and its reason. That exclusion alone moves 19 of 41 projects by at least one place; the largest move is Small Relay (prj_19), 14th to 30th.

**Why little else moves.** The estimated leniency is about 2 % of judge disagreement: β̂² = 0.0100 against σ̂² = 0.4276, so the engine keeps from 2 % (a judge with one review) to 21 % (a judge with eleven) of a judge's own tilt, and every kept judge's leniency ends within ±0.06. The signal check — a permutation test that shuffles the review totals and counts how often the shuffled project means spread at least as far as the real ones — finds no project differences beyond chance: permutation share 0.764 over 2,000 shuffles, where a share near 0 would mean real differences. Its positive control, planted project differences, is detected. On this event the engine's job is not to change the ranking; it is to bound and disclose what bias could have done.

| Rank | Project | Track | Reviews counted | Raw, all judges (rank) | Raw, without flat judge (rank) | Normalized | Move |
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

**The duplicate is the measured noise floor.** The same project entered twice by team CopperLedger as "Dry Harbour" (prj_07 and prj_41) ranks 31.5th and 9th of 41 unmerged on raw means; merged, it ranks 22nd of 40. Consequence: read neighbouring ranks as ties; the public results page shows scores next to places.

## Assignment

A fresh run starts with a bridge pre-pass: every judge with two or more tracks gets `bridgePerTrack` projects, default 2, in each of its tracks, fewest seats filled first. Then a greedy pass picks the most constrained open project (fewest spare eligible judges) and gives it the least-loaded eligible judge from its own track; ties are broken by a seeded random draw. The seed and every parameter are stored with the run, and the same seed on the same data gives the same assignment (tested). A top-up run keeps every existing pair and fills only missing reviews.

Conflicts: a judge on a project's team never gets it, and a judge can declare a conflict of interest, which removes the assignment from the engine. The engine never assigns across tracks. A project with fewer than two eligible judges in its track is flagged under-reviewed, and only an organizer can give it a judge by hand, with a reason that goes into the audit log. Each judge's projects come in a seeded random order, so no project is always read first or last.

Why bridges: normalized ranks compare within a track; tracks compare only through judges who score in both.

## Scoring

The organizer defines the rubric: criteria with weights (the sample event uses equal weights), each scored on the criterion's scale (1 to 5 here). A review's total is Σ weight × score ÷ Σ weight, and the judge sees the formula filled in. A review counts only when every criterion is scored; a missing criterion is stored as absent, never as zero, and the review is shown as unfinished.

Judges see only their own scores ("your ranking so far" lists their own finished reviews); the server refuses any other judge's scores with 403 (tested, and checked by the organizers' own acceptance suite). Scoring closes when judging closes or when results are published.

## Normalization

Each counted review's weighted total y = project level + judge leniency + noise. Project levels are not shrunk: a project with fewer reviews is never pulled to the middle for it. Each judge's leniency is shrunk by n ÷ (n + k), with k = σ̂² ÷ β̂² estimated from the event's own scores on every run. The estimator: d is a review minus the mean of the other reviews of the same project; for each judge with two or more such deviations, C = Σ over pairs of their deviations d_r × d_s ÷ Σ over the same pairs [1 + shared ÷ ((m_r − 1)(m_s − 1))], where shared is the number of other judges who reviewed both projects and m is the reviews per project; β̂² = max(0, Σ (n_j − 1) C_j ÷ Σ (n_j − 1)); W is the pooled within-project variance and σ̂² = max(0.05, W − β̂²). If β̂² is 0, no leniency is corrected and each project's score is its plain mean. The fit solves the normal equations directly (one Cholesky); an alternating solver reaches the same answer to within 1e-11 (tested). On the fixture: W = 0.4376, β̂² = 0.0100, σ̂² = 0.4276, k = 42.59, so a judge needs about 43 reviews before half their tilt counts; every kept judge's leniency is within ±0.06. A project's normalized score is exactly the mean of its reviews after each judge's leniency is subtracted, and the organizer's results page shows that receipt for every project.

The flat-judge rule: a judge with at least 3 finished reviews and the identical score vector on every project is left out as a whole judge, with a visible flag and its reason. In simulation the rule flags an honest judge in 7.7 % (no bias), 8.0 % (moderate bias) and 6.2 % (moderate bias, noisy judges) of 1,000 panels on the fixture's pairs. That is why it is a reversible flag and never a silent deletion: the organizer can reinstate a flagged judge or exclude any judge, only with a written reason, and can undo either. Every override is audited and stored with the run.

Duplicates: the organizer can merge two copies. The kept copy inherits the other's reviews, a judge who scored both counts once (their average), no score is deleted, and which copy is kept does not change the merged result (tested). A project left with fewer than 2 counted reviews is flagged under-reviewed; the organizer can top up its reviews or publish it as it is, marked. Publishing is refused while any of these decisions is open, and it stores the exact run it publishes.

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

## The audit trail

Every change and every refused request is written in the same database transaction as the change. Triggers refuse UPDATE and DELETE on the log, and they are re-created at every start. Each row carries the hash of the row before it. The organizer's audit page and `audit.csv` show the head hash. Limits, stated plainly: the triggers stop the application, not someone holding the database file; the chain is tamper-evident only against a head hash you kept outside the portal.

## Threat model

### Sybil votes

**What is built:** nothing to attack. Public community voting is not built yet; the only votes are judge reviews, one per judge per assigned project, refused for anyone but the session's judge.

**What is not:** public voting at all. If it is ever added, it needs one-person-one-vote identity and per-voter limits before its numbers can be trusted. Nothing here promises it.

### Ballot stuffing

**What is built:** a judge scores only their assigned projects, matched against the session and not the request; out-of-scale values are refused by the application and again by database triggers on the score rows; every change is audited with before and after.

**What is not:** community voting (above), so there is no public ballot to stuff in this build.

### Submission scraping

**What is built:** drafts are private, and the gallery and the API show only submitted projects.

**What is not:** rate limiting. There is none yet, so a client can read the public endpoints as fast as it likes; what it gets is what the organizer chose to make public.

### Judge collusion

**What is built:** judges cannot read each other's scores (backend-enforced, tested); every score change is audited with before and after; the leniency model limits what one generous or harsh judge can do; the flat-judge rule catches a judge who scores everything the same.

**What is not:** detection of coordinated collusion. Two judges trading favourable scores look like ordinary disagreement to the model; nothing flags that. The audit log keeps the evidence for an organizer to read.

### Deadline gaming

**What is built:** the submission deadline is enforced on the server — exclusive close time, refusal with 403, audited. A late duplicate is handled by the merge decision.

**What is not:** a grace period. The close time is exclusive by design: a submission before it counts, one at or after it does not.

## What it does not do

No calibrated prize probabilities or rank intervals. A method that produced them was tried in planning and cut: on simulated events with no real differences it named a 50 %+ favourite in 46 of 80 tracks (planning simulation of 2026-09-24, not re-run in this repository). Normalized ranks compare within a track, not across. With few reviews per judge the engine corrects little, by design. No automatic cross-track assignment.
