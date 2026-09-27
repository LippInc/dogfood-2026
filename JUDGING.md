# How judging works

This document states how the portal turns judge scores into results, and defends the choices with measurements. The scores pass through three steps: assignment of projects to judges, scoring against the organizer's rubric, and normalization, which estimates each judge's leniency from the event's own scores and subtracts it. An organizer can instead have judges answer "which of these two is better?"; that mode has its own section, "Pairwise mode". It also states what the engine does not do and where the audit trail stops.

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

Conflicts: a judge on a project's team never gets it; a judge assigned to a project cannot join its team afterwards (403 `conflict_of_interest`) unless they first declare the conflict; and a judge can declare a conflict of interest, which removes the assignment from the engine. The engine never assigns across tracks. A project with fewer than two eligible judges in its track is flagged under-reviewed, and only an organizer can give it a judge by hand, with a reason that goes into the audit log; choosing a judge from another track adds that track to the judge in the same audited action. No judge ever sees a project outside their own tracks, and that is checked on every judge-facing read and save, not only by the assignment run: once judges are assigned, the team can no longer change the project's track, and a project in a track the organizer takes away from a judge leaves that judge's console and refuses their saves (403 `outside_your_tracks`); a review already finished stays in the data. Each judge's projects come in a seeded random order, so no project is always read first or last.

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

## Pairwise mode

An event can be judged by pairwise answers instead of rubric scores. The organizer switches the mode on Settings, with a reason, until results are published; after that the mode and every answer are final. In this mode a judge never gives a number. They answer, about two of their own projects at a time, which is better: left, right, or "too close to call". Each project is placed into the judge's own ranked list, one at a time: the new project is compared with the middle of the range it can still take (binary insertion), so placing a project into a list of n takes at most ⌈log₂(n + 1)⌉ answers (tested) and six projects take at most eleven; "too close to call" places it right below the project it tied with. The judge can take back their latest answer in a track, and its question comes back. The list and the next question are replayed from the judge's own answers on every read and every write, so there is no second copy of that state to drift: an answer is accepted only for the exact question the server would ask now (409 `question_changed`, nothing stored), and an answer that no longer fits the replay (its project was merged away or left the judge's tracks) is skipped instead of breaking the list, so the judge's later answers still count (tested). Which project sits on the left is fixed per judge and pair by a hash, with the new project on the left in about half the questions (tested). Only the event's judges answer, and only an organizer sees the ranking or switches the mode; every refusal has a positive control (`tests/pairwise-dal.test.ts`).

Why: a judge's scale stops being a problem by not existing. Normalization has to estimate each judge's leniency from the event's own scores; here the judge is never asked for a number, only for an order of the projects they were assigned, so there is no leniency to estimate and no 4 from one judge to set against a 3 from another.

The model: every project has a strength s, and the chance that the left project wins an answer is

    logit P(left wins) = s_left − s_right + h + ν · (+1 if the project just opened is on the left, −1 if on the right)

where h is the pull of the left side and ν the pull of the project the judge has just opened: the two ways the frame of a question could tilt an answer, both estimated from the event's own answers and reported with their ±. "Too close to call" counts as half a win each way. The priors are s ~ N(0, 2²), which also keeps a project that won everything finite, and h, ν ~ N(0, 0.5²). One fit over every comparison maximizes the log-posterior with Newton's method, which finds its one maximum because the log-posterior is concave; each strength's ± comes from the inverse of the negative Hessian at the maximum (the Laplace approximation). The engine is pure (it reads no database), so the same answers always give the same ranking.

**Why this model, and not Crowd-BT.** The organizers point to Gavel, which fits Crowd-BT: Bradley-Terry with a reliability number for each judge, fitted from the answers, that down-weights (or even reverses) a judge the model finds unreliable, and a next pair chosen for each judge to learn the most. We keep plain Bradley-Terry for three reasons. First, reliability: a judge here answers about log₂(k!) questions for k projects (eleven at most for six), too few to estimate a weight that quietly decides how much their word counts; so the portal measures each judge's agreement with the rest of the panel and flags, and the organizer decides with a written reason (the flag's error rates are measured in "The proof"). Second, pair choice: judges here have an assigned batch (see "Assignment"), not a room to walk, so each judge places their own projects by binary search: every answer is used, the answers always form one consistent order per judge, and it takes about log₂(k!) of them. Third, the frame of the question: the two pulls, the side a project is shown on and the project just opened, are estimated and taken out rather than assumed away. The ranking is global in the sense the bonus asks: one fit over every comparison in the event, from judges who each saw only part of it. It is reported per track because judges compare projects only within a track, so no answer links two tracks, and an order across them would be the prior's, not evidence (the same reason a track split into groups says so).

The organizer's Results tab shows, per track: **win %**, each project's chance of beating an average project of its track, σ(s − the track's mean strength), with a ± computed from the full covariance; **ahead of the next**, the chance this place really is ahead of the one below it, given only when the two are linked by comparisons; **groups**: projects joined through comparisons share a group, and a track split into groups says so, because nothing was measured across the gap; projects never compared come last; and a **receipt** per project listing every comparison that entered the fit, judge by judge, with its result and weight. The two pulls are shown in plain words ("the project shown on the left wins 56 % between two equal projects"), but only once each is known within 6 points; before that the card says it is not measured yet, with the answer count and the current ±, because a pull read off a handful of answers is the prior's, not a finding.

Finished rubric reviews count too, as orders: a judge's k reviews in one track say "this is my order of these k projects", and every two of them become a comparison, the higher total winning (equal totals: too close to call), each weighted 2/k. A judge's order of k projects so weighs k − 1 comparisons in total: their say grows with how many projects they ordered, not with its square (tested). A judge's answers replace their score order where they cover it: a pair implied by scores drops out once that judge has placed both of its projects by answers. Excluded judges (the flat-judge rule and the organizer's own decisions) are left out of the fit, and a merged duplicate counts for the copy kept.

The coin-flip flag: a judge with at least six answers whose answers agree with the rest of the panel no better than coin flips would (z below 0), or who calls "too close to call" more than half the time. Agreement is measured against a fit of everyone else's comparisons, each of the judge's answers weighted by how sure the rest of the panel is about that pair; a tie always earns half, so ties add nothing to the variance of z.

Before publishing, the organizer settles, in the same list as the scores mode's decisions: each flagged judge, kept or left out with a written reason (a flag is a question for the organizer, never an automatic exclusion); each project that fewer than two judges compared, published as it is with a reason; and any duplicate entry. Publishing stores the run in the same tables as a score run (method `bradley-terry-v1`): the fitted win % where the normalized score goes, the plain share of comparisons won (ties half) where the raw mean goes, the ±, both ranks, and how many judges compared the project where the review count goes. The results page, the team's page, the records and the exports read a pairwise event like any other, and say how its places were made.

In scores mode the organizer's Results tab carries the same engine as a cross-check: the event's reviews read only as each judge's order of their own projects, fitted as above, and set against the normalized order per track (Kendall's tau-b, 1 for the same order) with the projects whose places differ most. Because it never compares one judge's number with another's, no leniency can move it. On the sample event it agrees at τ = 0.78 across tracks (0.33 to 1.00 per track; the lowest in the three-project Climate track), and it places the two copies of the project entered twice apart, as their different judges did.

### The proof

`tests/pairwise-mc.test.ts` builds simulated events on the fixture's real tracks and judge–project pairs: every simulated judge places their assigned projects by binary insertion exactly as the Compare screen asks, answering from known project qualities, their own discrimination, and planted pulls h = 0.3 and ν = 0.2. The assertions were declared before the first run (2026-09-27). Run it with `npx vitest run tests/pairwise-mc.test.ts` (about a minute); it prints the numbers below.

- (a) Declared: the engine's mean Kendall tau with the true order is above the plain win rate's. Measured over 200 runs with the pulls present: 0.680 (sd 0.088) against 0.678 (sd 0.082), a difference of 0.002 with a run-to-run sd of 0.044. The assertion holds, but by far less than the noise, so the honest reading is that the engine **matches** the win rate on ranking accuracy. What it adds is the two pulls measured and taken out, a ± that is calibrated (d), the chance each place is ahead of the next, groups said out loud, the flag and the receipts. Known-bad: the same fit with the projects' labels shuffled must fail (a); it scores a tau of 0.017.
- (b) With no pulls planted, 200 runs: engine 0.674, win rate 0.686, a difference of −0.011 (sd 0.040): the engine trails by no more than the run-to-run sd, as declared.
- (c) The mean pull estimates land within the declared 0.1 of the truth: h 0.241 (true 0.3, sd 0.194), ν 0.141 (true 0.2, sd 0.192).
- (d) The 95 % intervals for win % cover the truth 0.950 of the time over 6,150 project-runs (declared window 90 to 99 %).
- (e) 120 panels, each with one judge answering at random and one answering honestly except that every answer their favourite would lose becomes "too close to call": the flag fires on 68 of 120 random answerers (56.7 %) and on 88 of 967 honest judges (9.1 %, declared bound 15 %). The strategic judge is not caught reliably: flagged in 9 of 120 panels, their ties bought the favourite 0.31 places on average, at most 2.

## The audit trail

Every change is written in the same database transaction as the change, and so is every refusal of someone the portal knows: a signed-in person or a voter holding a link (403). A request with no valid session (401) leaves no row, since anyone can make those without end; and past 60 refusals in 10 minutes a person is answered 429 with no row, so one account cannot fill the log. Triggers refuse UPDATE and DELETE on the log, and they are re-created at every start. Each row carries the hash of the row before it. The organizer's audit page and `audit.csv` show the head hash. Limits, stated plainly: the triggers stop the application, not someone holding the database file; the chain is tamper-evident only against a head hash kept outside the portal. The portal spreads such heads as it goes: each signed certificate and judging record carries the newest entry's number and hash inside its signature (the record's page says whether the log still holds that entry as signed), and the public results page shows the entry that published the results. The signing key itself is sealed under the portal's secret, so a copy of the database cannot sign new records to match a rewritten log.

## Threat model

In its own file, `THREAT-MODEL.md`: Sybil votes, ballot stuffing, submission scraping, judge collusion, deadline gaming, tactical pairwise answers, forged requests and filling the audit log, each with what is stopped and what is not.

## What it does not do

No calibrated prize probabilities or rank intervals: each score carries a ± of one standard error, and the portal does not turn it into rank intervals or prize odds. A method that produced them was tried in planning and cut: on simulated events with no real differences it named a 50 %+ favourite in 46 of 80 tracks (planning simulation of 2026-09-24, not re-run in this repository). Places are decided within a track; the overall ranking (the organizer's table, and the table above) is a convenience view, since tracks compare only through judges who score in both, so read the order across tracks loosely. With few reviews per judge the engine corrects little, by design. No automatic cross-track assignment.
