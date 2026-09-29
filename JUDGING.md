# How judging works

This document states how the portal turns judge scores into results, and defends the choices with measurements.

The scores pass through three steps:

1. assignment of projects to judges;
2. scoring against the organizer's rubric;
3. normalization, which estimates each judge's leniency from the event's own scores and subtracts it.

An organizer can instead have judges answer "which of these two is better?"; that mode has its own section, "Pairwise mode". The document also states what the engine does not do and where the audit trail stops.

**The evidence is checkable.**

- `tests/normalization-mc.test.ts` builds simulated events on the sample event's own 126 judge–project pairs and scores the engine against the raw mean. `npx vitest run tests/normalization-mc.test.ts --silent=false` (Node 24, after `npm ci`; a few seconds) prints the Monte Carlo table under "Validation" exactly as it stands there; vitest prints nothing of it without `--silent=false`.
- `tests/normalize-oracle.test.ts` checks the fit against the planning run's numbers and against planted leniency.
- `tests/normalize-errors.test.ts` checks the ± on every score by simulation.
- `tests/judge-ledger.test.ts` holds the single-judge influence check to what an override then does.
- The organizers' acceptance suite re-checks the score-refusal rule.

On a running instance the organizer can export `normalized.csv`, `audit.csv` and `event.json`. Every number below about the sample event is recomputable from those exports. That includes the signal check's shuffles: the published run in `event.json` stores its seed, the shuffles draw from the same seeded generator as assignment runs, and `tests/signal-from-export.test.ts` rebuilds the published share exactly from `event.json` alone (finished reviews in order of score id, one observation per judge and project in the order of its first review, the run's excluded judges left out).

Where each feature beyond the organizers' checker stands (community voting and the rest of T3, and T4) is in the README's "Beyond the checker" table, with the hand-check output in `isolation-report.txt`.

## The finding on the sample event

The sample event (`fixtures.json`) has 41 projects and 126 finished reviews. Four findings drive the design.

The numbers in this section are the sample event as imported, with only the flat-judge rule applied.

The README's tour then settles the other two open decisions (the duplicate prj_41 merged into prj_07, Small Relay's single review accepted) and publishes. So the run a judge sees after the tour, on the organizer's Results page, has 40 projects and moves a little:

- k = 36.1 (β̂² = 0.0113, σ̂² = 0.4065);
- the largest kept leniency 0.072 (Wei Lindqvist);
- permutation share 0.7285 (2,000 shuffles, same seed);
- Small Relay from 13th on the raw mean to 30th.

The engine computes both from the data; neither is typed in.

**One flat judge matters.** Judge Iva Petrova (jdg_07) scored all 3 assigned projects 4 / 4 / 4 — the identical vector on every project, so those reviews rank nothing. The flat-judge rule leaves Iva Petrova out as a whole judge, with a visible flag and its reason. That exclusion alone moves 19 of 41 projects by at least one place; the largest move is Small Relay (prj_19), 14th to 30th.

**Why little else moves.** The estimated leniency is about 2 % of judge disagreement: β̂² = 0.0100 against σ̂² = 0.4276. So the engine keeps from 2 % (a judge with one review) to 21 % (a judge with eleven) of how far a judge's reviews sit from the fitted project levels, and no kept judge's leniency exceeds 0.062 in size.

The signal check — a permutation test that shuffles the review totals and counts how often the shuffled project means spread at least as far as the real ones — finds no project differences beyond chance: permutation share 0.7645 (1,529 of 2,000 shuffles), where a share near 0 would mean real differences. Its positive control, planted project differences, is detected.

On this event the engine's job is not to change the ranking; it is to bound and disclose what bias could have done.

**The organizers' yardstick.** The event page measures a normalization by the spread of the judges' own averages (the standard deviation of per-judge means: 0.42 for the fixture's 30 judges). On the 29 judges the engine counts it is 0.416, and with each judge's estimated leniency taken out, 0.398.

That the engine moves it so little is the finding, not a failure:

- Judges with no tilt at all, scoring these same 123 judge–project pairs with this event's own project spread and review noise, are about 0.37 apart by luck alone (90 % of 400 seeded runs between 0.28 and 0.48, and 20 % reach 0.416 or more), because each judge saw about four projects.
- A normalization that squeezed the spread towards 0 would be moving projects on luck.
- When the tilt is real, the yardstick shows it: with three judges made 0.6 more generous, the spread rises to 0.52, above that band, and the engine brings it back to 0.38 (`tests/yardstick.test.ts`).

Both results pages show these numbers for any event (the public one under "How these scores were made", one click from the top), computed by `src/server/judging/yardstick.ts` from the run they describe.

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

**One judge can move many places.** The single-judge influence check reruns the whole engine with one judge's status flipped. Leaving out any one of the 29 counted judges moves between 3 and 34 of the 41 projects by a place or more (median 20), and for 11 of them some track's first place changes.

It is the signal check's finding seen from the judges' side: on scores this close, one review in three decides places. The organizer sees this for every judge in the judge ledger before making any override, and each score carries its ± (0.38 for a project with three counted reviews), so neighbouring places read as ties.

## Assignment

This section says how projects are given to judges, what keeps a judge off a project, and how tracks bound it all.

A fresh run has two passes:

1. A bridge pre-pass: every judge with two or more tracks gets `bridgePerTrack` projects, default 2, in each of its tracks, fewest seats filled first.
2. A greedy pass picks the most constrained open project (fewest spare eligible judges) and gives it the least-loaded eligible judge from its own track; ties are broken by a seeded random draw.

The seed and every parameter are stored with the run, and the same seed on the same data gives the same assignment (tested).

A top-up run keeps every existing pair and fills only missing reviews. A seat counts as filled by a finished review, or by an open one its judge can still finish. An open review of a project that is no longer in any of its judge's tracks (the project moved, or the judge lost the track) never reaches that judge's console, so the next top-up gives the project another judge from its track; the old pair stays in the data.

**Conflicts:**

- a judge on a project's team never gets it;
- a judge assigned to a project cannot join its team afterwards (403 `conflict_of_interest`) unless they first declare the conflict;
- a judge can declare a conflict of interest, which removes the assignment from the engine.

**Mistakes an organizer can undo:**

- a recusal clicked by mistake (the review comes back as it was, finished if it was);
- an assignment its judge has saved nothing on (no score, no feedback and, in pairwise mode, no answer comparing its project), for a judge picked by mistake; no run gives a taken-back pair again, though an organizer still can by hand.

Both need a reason, are audited, and stop once the results are published. A started review and a recusal are never taken back, since they are the judge's own work and word.

**Tracks.** The engine never assigns across tracks.

- A project with fewer than two eligible judges in its track is flagged under-reviewed, and only an organizer can give it a judge by hand, with a reason that goes into the audit log.
- Choosing a judge from another track adds that track to the judge in the same transaction. The track then reaches every project in it (later top-ups, pairwise questions), so:
  - the grant is written as its own row (`judge.tracks`, naming the hand assignment, the project and the reason) beside the assignment's, and the log says which track was added;
  - the Judges page marks the track "by hand" with the project it came with, for as long as that hand assignment is the judge's latest grant of the track (taken off and given again with the tracks form, it is no longer marked).

No judge ever sees a project outside their own tracks, and that is checked on every judge-facing read and save, not only by the assignment run:

- Once judges are assigned, the team can no longer change the project's track.
- An organizer can move it, with an audited reason:
  - unstarted reviews by judges who do not judge the new track are withdrawn (a pairwise answer about the project counts as started);
  - finished ones stay and keep counting;
  - a started one stays in the record out of its judge's console;
  - the next top-up brings judges from the new track;
  - since places compare within a track, a move can change a track's winner, so the published run keeps every move and the public results and the project's page show it next to the project, with the date and the reason.
- A project in a track the organizer takes away from a judge leaves that judge's console and refuses their saves (403 `outside_your_tracks`); a review already finished stays in the data.

Each judge's projects come in a seeded random order, so no project is always read first or last.

Why bridges: normalized ranks compare within a track; tracks compare only through judges who score in both.

## Scoring

The organizer defines the rubric: criteria with weights (the sample event uses equal weights), each scored on the criterion's scale (1 to 5 here).

- The set of criteria is fixed once the first score arrives.
- A weight can still change after that, to fix a mistake, but only with a written reason: the change is audited and the published results show it (the weights before and after, when, and why), so nobody re-weights the ranking quietly with the standings in view. Before judging starts, the rubric form says so in red.
- Labels and prompts can be reworded until publishing.
- A review's total is Σ weight × score ÷ Σ weight, and the judge sees the formula filled in.
- A review counts only when every criterion is scored; a missing criterion is stored as absent, never as zero, and the review is shown as unfinished.

Judges see only their own scores. "Your ranking so far" lists their own finished reviews; an organizer who wants each project scored against the rubric rather than against the ones before it hides that list in Settings, "How judges judge", an audited switch. The server refuses any other judge's scores with 403 (tested, and checked by the organizers' own acceptance suite).

Scoring closes when judging closes or when results are published.

## Normalization

This section is the method: the model, how it is estimated and solved, the ± on every score, and the organizer's tools around it (the judge ledger, the flat-judge rule, removing a judge, duplicates, publishing).

**The model.** Each counted review's weighted total y = project level + judge leniency + noise.

- Project levels are not shrunk: a project with fewer reviews is never pulled to the middle for it.
- Each judge's leniency is shrunk by n ÷ (n + k), with k = σ̂² ÷ β̂² estimated from the event's own scores on every run.

In plain words: each judge's deviations from the other reviewers of the same projects are compared with each other. If they lean the same way across projects more than chance allows, the judge has a leniency. Pairs of projects that share reviewers count for less, because their deviations agree partly by construction.

**The estimator:**

- d is a review minus the mean of the other reviews of the same project;
- for each judge with two or more such deviations, C = Σ over pairs of their deviations d_r × d_s ÷ Σ over the same pairs [1 + shared ÷ ((m_r − 1)(m_s − 1))], where shared is the number of other judges who reviewed both projects and m is the reviews per project;
- β̂² = max(0, Σ (n_j − 1) C_j ÷ Σ (n_j − 1));
- W is the pooled within-project variance and σ̂² = max(0.05, W − β̂²).

If β̂² is 0, no leniency is corrected and each project's score is its plain mean. When no judge has two reviews of projects someone else reviewed too (two judges on one project, say), β̂² has no data at all: the pages then say the reviews are too few to estimate how lenient each judge is and that scores are used as given, rather than that no leniency was found, and the judge ledger stays folded away, one click from the override (tested).

**How it is solved.** The fit solves the normal equations directly. The project levels, which are not shrunk, are eliminated exactly first, which leaves one system with a row per judge, solved by one Cholesky; the full system and an alternating solver reach the same answer to within 1e-10 and 1e-11 (tested).

So the cost grows with the number of judges, not projects: on a simulated event of 1,000 projects and 150 judges one fit with its errors takes about 25 ms, and the judge ledger's 150 reruns about 1.4 s (`tests/normalize-scale.test.ts` prints these on the machine that built this; the test asserts only a loose ceiling, since timings vary by machine).

**On the fixture:** W = 0.4376, β̂² = 0.0100, σ̂² = 0.4276, k = 42.59, so a judge needs about 43 reviews before half their tilt counts; no kept judge's leniency exceeds 0.062 in size.

**The receipt.** A project's normalized score is exactly the mean of its reviews after each judge's leniency is subtracted. The organizer's results page shows that receipt for every project, with the change from the raw mean split into what leaving judges out did and what the leniency correction did.

**The ±.** Each score and each fitted leniency carries a ± of one standard error from the same fit: √(σ̂² × that estimate's entry on the diagonal of the inverse of the matrix the fit solves).

- It counts both the ordinary scatter of the reviews and the extra doubt from having to estimate each judge's leniency from those same reviews (in statistics terms, the mixed-model equations with the leniencies as the random part), so a score's ± is never below σ̂ ÷ √n.
- On the fixture a score's ± is 0.66 with one counted review, 0.47 with two, 0.38 with three, 0.33 with four and 0.30 with five.
- Every kept judge's leniency carries ±0.09 to ±0.10, against at most 0.062 of leniency: no single judge's leniency stands out from its own ±, though the panel as a whole shows some, which is what β̂² = 0.0100 measures.
- A judge's ± is shown only when leniency is fitted (β̂² > 0).
- When no project has two counted reviews, nothing measures the review noise (W has no data), so no ± is shown at all: the 0.05 floor alone would pose as a measurement. The scores are computed as usual.
- Publishing stores each score's ± with the run, and the public results page and each team's own page show it next to the score.

**The judge ledger,** on the organizer's results page, lists every judge with a finished review:

- reviews counted, plain tilt, leniency ± error;
- the share of the plain tilt the engine actually takes off (leniency ÷ plain tilt, left blank under a tilt of 0.05, where the ratio would divide by noise). This is not the n ÷ (n + k) above, because the fitted project levels the engine starts from already allow for the co-reviewers' own leniency: on the sample event one judge with a plain tilt of +0.33 keeps 14 % of it where n ÷ (n + k) says 19 % (tested);
- any flag or override;
- the single-judge influence check. The check reruns the whole engine with that judge's status flipped (left out if counted, counted again if left out) and reports how many projects move a place or more, the largest move, and any track whose first place changes.

The override is made from the same row, with a required reason, until results are published. On the fixture, a test flips every judge in turn and checks that the override moves as many projects as the check predicted, with the same largest move and the same changes of first place.

**The flat-judge rule:** a judge with at least 3 finished reviews and the identical score vector on every project is left out as a whole judge, with a visible flag and its reason.

In simulation the rule flags an honest judge in 7.7 % (no bias), 8.0 % (moderate bias) and 6.2 % (moderate bias, noisy judges) of 1,000 panels on the fixture's pairs. That is why it is a reversible flag and never a silent deletion: the organizer can reinstate a flagged judge or exclude any judge, only with a written reason, and can undo either. Every override is audited and stored with the run.

**Removing a judge:** an invitation accepted by the wrong account, or a judge who has to go, is undone on the Judges page (the judge's name), with a reason, audited as `judge.remove`, until the results are published.

- The judge's role and tracks end, so the console and every judge route refuse them.
- Open reviews they never started (no score saved and no pairwise answer about the project) are withdrawn and a top-up fills those seats.
- Nothing they saved is deleted. If they saved anything (a review, a draft, a pairwise answer), an exclusion carrying the reason ("Removed as a judge: ...") leaves all of it out of the ranking, the same mechanism as a hand exclusion. So the receipts and the ledger show those reviews struck through and name the judge as removed, and the published run's parameters keep the reason.
- Teams never see a removed judge's review.
- The exclusion cannot be undone while the person is out (409 `judge_removed`); only if they join again through a new invitation can an organizer count those reviews again, by reinstating them with a reason.

**Duplicates:** the organizer can merge two copies. The kept copy inherits the other's reviews, a judge who scored both counts once (their average), no score is deleted, and which copy is kept does not change the merged result (tested).

- A project left with fewer than 2 counted reviews is flagged under-reviewed; the organizer can top up its reviews or publish it as it is, marked under-reviewed on the public results.
- Until the results are published, each of these decisions can be undone from the overview, and the undo is logged like the decision.
- A community vote on a merged copy counts for the copy kept, so a merge or unmerge after the voting window closed moves a count that is already public. It is not refused (a duplicate found late still has to be handled), but when it moves any vote, its audit row records each project's votes before and after, and the count, public and the organizers', lists it beside the tally.

**Publishing** is refused while submissions are still open (a project sent later would be missing from the results) and while any of these decisions is open, and it stores the exact run it publishes.

- From then on `normalized.csv` is read from that stored run (the engine's whole table, kept with the run), not worked out again, so a later engine or anything that moved since cannot change it. A pairwise run exports its own columns (judges, win rate, win %, its ±, ranks, track place). Win % is measured against the project's own track's average, so `rank_win_pct`, which ranks it across the whole event, orders how far above its own track's average each project stands, not a cross-track order; `track_place` is the place.
- The organizers' results page (and `GET /api/events/{event}/normalization`) still works the score ranking out live, for its working. After publishing it compares that with the stored run, and should any project's score or rank differ (a later engine), it says so and stops calling the view the published run.
- After publishing, the scoring rubric, the event's dates, the tracks (their names and order, which group and head the published results), the tie-break and the judge assignments are final too (409), so every live view, export and judge's console keeps matching what was published.

### Breaking exact ties

By default, projects in one track whose published scores are exactly the same share a place ("Joint 2nd"). "Exactly" is the places' own rule: scores within 1e-9 of each other, so two numbers that differ only by floating-point rounding count as equal. An organizer can instead choose one rubric criterion to break such ties (Settings, "Exact ties", or `PUT /api/events/{event}/tie-break`). The rule, as `src/server/judging/tiebreak.ts` applies it:

1. The engine's scores decide the order, unchanged. The tie-break never touches a project whose score is not exactly tied with another's in its track, and never compares projects across tracks.
2. Within an exact tie, each project's figure on the chosen criterion is the plain mean of that criterion over the project's counted reviews. The engine corrects only the weighted total for leniency, never a single criterion, so there is no normalized per-criterion score to use. The counted reviews are the ones the score counts: finished, not recused or conflicted, from judges not left out. A merged copy's reviews count for the copy kept, and a judge who scored both copies counts once, at the mean of the two.
3. The higher figure places first. Projects whose figures are also within 1e-9 of each other stay joint, sharing the first place of their group.

Where this rule decides a place, it says so: on the public results, per track and in the overall order ("Exactly tied on score; tie broken by <criterion>", with the project's plain average on the criterion, and the method block above the tracks names the rule: "Projects with exactly the same score are then ordered by their plain average on <criterion>, a rule the organizers chose; it is a convention, not a measured difference."), the project's page, the team's own My project page, the embed, each certificate's award line ("2nd place, Data and analytics, tie broken by Functionality") and `normalized.csv` (before and after publishing). A project the criterion left joint (two still tied on it, both ahead of a third, say) carries no such note anywhere, since its place is still a joint one: all of these read one shared condition (`tieDecided` in `src/lib/places.ts`). The CSV gains three columns only when the event uses a tie-break: `tie_break_figure`, `track_place` and `tie_broken_by`. `track_place` is the published place (after the finals too, when a track held them); `track_rank` stays the engine's own average rank. The organizer's Results tab lists every exact tie, how the criterion ordered it, and which ties it left joint. The ranking-evidence count of projects "at a different place than the plain average" compares the engine's scores with the plain figure, before any tie-break.

Choose the criterion before publishing; the choice is audited (`event.tie_break`). Once any judge has scored, a change needs a written reason, because by then an organizer can see which projects a criterion would favour. The reason is kept on the event, and the published results show the change, as they show a weight change. Publishing stores the criterion and each tied project's figure with the run, and the publish audit row lists every exact tie with its figures and places. From then on the tie-break is final: the app refuses a change (409 `results_published`), and a trigger refuses a settings write that changes it.

Pairwise mode has no criteria, so the setting does not apply there. Setting one in pairwise mode is refused (409 `pairwise_mode`), and switching an event to pairwise turns the tie-break off in the same audited change. Once any judge has scored, that switch is also listed among the tie-break changes the published results show (the criterion, then joint places, with the switch's reason), so the results never name a tie-break the ranking did not use, also when the event switches back to scores. A pairwise ranking's equal win % keep a joint place, as before. A criterion that breaks ties cannot be removed from the rubric (409 `tie_break_criterion`) until another tie-break, or joint places, is chosen. With no tie-break set, every page, export and number is exactly what it was before this setting existed (`tests/tiebreak.test.ts` compares the sample event's published results and `normalized.csv` with a snapshot taken before it).

**"How this ranking was reached."** The public results page ends with this section (linked from the top of the page), for anyone who wonders how far to trust the places. It is read from the published run, never worked out again, and gives totals only:

- the method: with k, or the judges' answers and the pairs implied by scores, each kind counted apart, how many judges gave them, and, when the pairs implied by scores outnumber the answers, that more of the comparisons come from scores than from answers (the page's reading points and its "How these win % were made" say it in the same words, so no one takes the scores' pairs for answers); the two pulls the fit measured and corrected for, or that one is not measured yet and the fit corrects for its current estimate, still mostly the prior's (the gate of 6 points only decides what is shown; the correction is always on);
- how many counted judges the correction moved by at least 0.005 points of a review's total (the page states that number), with the largest and the median correction in size;
- how many judges were left out as a whole;
- how many projects stand at a different place in their track than the plain average of every review (or, pairwise, the plain share of wins) would put them, places counted as the page prints them before any tie-break or judges' decision (tied projects share the first place of their group, so joint 2nd to 3rd is a move), and where the judges' decision on a close call named a track's winner, the sentence says the count is by the scores and names each such track apart (`evidence.decidedIn`), so it never claims a place the page does not print; after the README tour that is 4 of the 40; and, pairwise, each track whose answers split into groups never compared with each other, whose places compare only within a group (the organizer's Results tab says the same);
- the signal check's verdict in one sentence (a pairwise run stores no signal check, so it has no such line);
- the audit entry the run was published as, with its hash (only for results published on this portal: an event imported already published has no such entry here, its publication is in the import's audit row, so the page leaves this line and the seal out).

It never names a judge or shows a judge's own figure, beyond the size of the largest correction; `tests/results-evidence.test.ts` holds it to that. The same numbers are the `evidence` field of `GET /api/events/{event}/results`.

## Close calls and the judges' decision

Scores this close often cannot name a winner, and real hackathons settle that by the judges deliberating. The portal says when a track's first place is too close to call and lets the organizer record what the judges decided.

**The rule.** A yes/no per track, read from the engine's own score and ± (one standard error, as the results show it):

- 4,000 draws, each giving every project of the track its score plus its ± times a standard normal number, and counting which project comes out on top.
- The draws come from one fixed seed (20260929) with the portal's one seeded generator, per track and in order of project id, so the same scores always give the same answer, on any machine, and one track's answer never depends on another track's projects (`src/server/judging/decision.ts`).
- A track's top is **too close to call** when the ranking's top project comes out first in fewer than 95 % of the draws (3,800 of 4,000). An exact tie at the top is always too close to call.
- **The close projects** are the fewest projects, those that win the most draws first, that come out first in 95 % of the draws together. The pages list them in score order, each with its score and ±, for example "Too close to call from the scores: Tide Clock 3.91 ± 0.22, Lantern Map 3.84 ± 0.25". The judges' decision may name any of them.
- **No chance of being first is shown**, on any page or in any API answer: only the yes/no and the close projects. Each project's share of the draws is not calibrated odds (see "What it does not do": on fields with no real differences such figures named a 50 %+ favourite in 46 of 80 tracks), so it stays inside the check.
- A project without a ± (the engine could not measure its noise) makes the check stop for its track: a missing ± would read as certainty, so no call is made either way.
- Nothing here changes a score or the score order. Pairwise events have no ± of this kind and no close calls.

**Its validation** (the engine experiment of 2026-09-29; its verifier runs on the same simulation as `tests/normalization-mc.test.ts`, 1,000 runs per visible scenario and 500 per sealed one, and is not part of this repository's tests; SINGLE-SOURCE):

- On simulated events with no real differences between projects, the rule named a winner in 0.13 % of 4,000 track-runs.
- When it named a winner, that project was the true best 99.2 % of the time (7,313 winners named across the three leniency scenarios), and 97.5 % to 99.8 % in every scenario, the sealed ones included. The noisy-judges scenario is the low end.
- It named a winner in 20 % (noisy judges) to 63 % (no bias) of track-runs where the projects really differ: the price of the 95 % line is many honest "too close to call" answers.
- It changes no ranking, and its share of draws is the verifier's baseline, so it is no better calibrated than the ±; only the 95 % line is validated, which is why only the line's yes/no is shown.
- The verifier drew for the whole event from one stream; the portal draws per track from the same seed. The rule is the same; the two differ only by the draws' own noise (about 0.3 percentage points at 95 %).
- A smaller check of the same rule runs in this repository (`tests/close-calls-mc.test.ts`): 150 simulated events of 8 tracks of 5 projects, 12 judges with their own leniency, 3 reviews per project, through the real engine and its ±. With no real differences it named a winner in 6 of 1,200 track-runs (0.5 %, asserted under 1 %); where projects differ it named one in 370 of 1,200 and 365 of those were the true best (98.6 %, asserted at least 95 %). Its known-bads: with the ± halved it names a winner in 182 of 1,200 no-signal track-runs (15 %) and fails the first line, and with no ± at all it names one in every track.
- `tests/close-calls.test.ts` holds the module to determinism (the same rows in any order give the same answer), a clear winner as the positive control, and a known-bad: a flat field (equal scores, equal ±) must not name a winner, while the same field read without its ± would.

**When it is a decision.** The organizer's Results page shows every track that is too close to call, with its close projects' scores and ±, for example "Too close to call from the scores: Slow Trail 3.62 ± 0.21, Salt Ferry 3.55 ± 0.24". A track the scores now decide that still carries an earlier choice is listed apart, as an earlier choice, and is not counted as a close call. Whether it must be settled before publishing depends on the signal check:

- **Scores with a signal** (permutation share at or below 0.05, the line the Results page draws): a track too close to call is a decision on the Overview, like the others, and publishing is refused (409 `decisions_open`) until it is settled. "Keep the ranking's winner" settles it with one click; or the organizer records the judges' decision, naming another of the close projects, with a written reason.
- **Scores without a signal** (share above 0.05): the scores cannot tell the projects apart anyway, so the close call only advises. The ranking's winner stands unless the organizer records the judges' decision, which is then listed on the Overview as a decision made.
- This keeps the sample event, the README tour, the acceptance suite and the hand checks as they were: every one of its tracks is too close to call (the ranking's top comes out first in 25 % to 65 % of the draws after the tour's three decisions, well under the line), but its signal check finds no signal (share 0.73 after them, 0.76 before), so nothing is added to its decisions.
- Each choice is one audited action (`results.close_call`, with the close projects it was made on; undo is `results.close_call_undo`) and can be undone until publishing. A choice stops counting when the scores move away from it (the ranking's first place changes, the named project leaves the close projects, or the track becomes clear); it is then an open decision again, and the page says why.

**Publishing with a judges' decision.** The judges' winner is placed first in its track, the others keep their order (the scores', then the tie-break's among exact ties, when the event sets one) and are placed from 2nd on; every other track is untouched. The run stores the decision (winner, reason, when, the score order's first place and the close projects), and the public results, the overall order, the project pages and the certificates read it from there: the track says "Winner by the judges' decision" with the reason, the close projects with their scores and ± and the order by score alone, and every score is shown unchanged; the overall order marks the winner's row "1st in its track by the judges' decision on a close call" with the reason and a link to the track; the certificate reads "1st place, <track>, by the judges' decision". The run is append-only, so the decision is frozen with it, and the choices kept on the event are final too: the app answers 409 `results_published`, and the trigger `events_close_calls_final` refuses any settings write that changes `closeCalls` once results are published. A run without a judges' decision stores nothing new, so its results, exports and certificates are what they were before close calls existed (tested byte for byte on the keys).

## Validation

This section is the evidence for normalization: the Monte Carlo against the raw mean, the assertions the test holds it to, and the check of the ±.

The Monte Carlo (`tests/normalization-mc.test.ts`): 1,000 fixed-seed runs per scenario on the fixture's own 126 judge–project pairs. Each run draws true project qualities, judge offsets and scales and review noise, rounds and clips to 1–5, and keeps the flat judge's real 4 / 4 / 4.

Methods:

- the raw mean;
- the raw mean with the flat judge left out, as the engine leaves it out, so that the engine's gain over it is the leniency correction alone;
- the engine at k = 3 (the earlier default, kept as the comparison row);
- the engine with k estimated (what ships).

Score: Kendall tau-b against the truth, over pairs in the same track and over all pairs. 1,000 runs per scenario, seed 20260923:

| scenario | method | within-track tau | pooled tau |
|---|---|---|---|
| no-bias control | raw | 0.917 (sd 0.042) | 0.892 (sd 0.026) |
| no-bias control | raw, flat judge out | 0.918 (sd 0.041) | 0.917 (sd 0.020) |
| no-bias control | k = 3 | 0.909 (sd 0.045) | 0.905 (sd 0.022) |
| no-bias control | engine | 0.914 (sd 0.044) | 0.911 (sd 0.022) |
| moderate bias | raw | 0.880 (sd 0.050) | 0.817 (sd 0.042) |
| moderate bias | raw, flat judge out | 0.881 (sd 0.050) | 0.832 (sd 0.040) |
| moderate bias | k = 3 | 0.895 (sd 0.047) | 0.849 (sd 0.035) |
| moderate bias | engine | 0.899 (sd 0.045) | 0.858 (sd 0.033) |
| moderate bias, noisy judges | raw | 0.754 (sd 0.078) | 0.722 (sd 0.053) |
| moderate bias, noisy judges | raw, flat judge out | 0.754 (sd 0.078) | 0.730 (sd 0.052) |
| moderate bias, noisy judges | k = 3 | 0.756 (sd 0.077) | 0.733 (sd 0.050) |
| moderate bias, noisy judges | engine | 0.756 (sd 0.077) | 0.732 (sd 0.050) |
| batch confound (known-bad for leniency) | raw | 0.800 (sd 0.070) | 0.794 (sd 0.053) |
| batch confound (known-bad for leniency) | raw, flat judge out | 0.801 (sd 0.071) | 0.811 (sd 0.051) |
| batch confound (known-bad for leniency) | k = 3 | 0.833 (sd 0.062) | 0.843 (sd 0.040) |
| batch confound (known-bad for leniency) | engine | 0.842 (sd 0.060) | 0.856 (sd 0.037) |

The test enforces three assertions, with margins declared before the run:

1. With no bias, the engine loses to the raw mean by no more than the run-to-run spread of the difference, within-track and pooled.
2. In the batch-confound case — a harsh judge given a genuinely stronger batch, a lenient judge a weaker one, the case a leniency model can get wrong — the engine's pooled tau is not below the raw mean's.
3. With moderate bias, with and without noisy judges, it trails k = 3 by no more than 0.010 within-track and 0.020 pooled.

The raw mean in (1) and (2) keeps the flat judge, whom the engine leaves out, so part of the engine's edge there is that exclusion. So more assertions compare against the raw mean with the flat judge left out too:

- **(1b) and (2b)** repeat (1) and (2) against it; they were declared before their first run, and both hold. With no bias the engine gives up 0.004 within-track and 0.006 pooled to it, inside the margin.
- **(1c)** is the tighter form of (1). (1) and (1b) take the run-to-run spread of the difference as their margin, not the error of its mean over 1,000 runs, which the third outside reading rightly called loose. So (1c) asks that, with no bias, the 95 % lower bound of the engine's mean difference from the raw mean with the flat judge out be above −0.010. Measured: −0.0046 within-track (lower bound −0.0053) and −0.0059 pooled (−0.0064). That margin was set after these runs were seen, so it states the measurement more tightly rather than predicting it; its job is to fail on a regression.
- In the batch confound the engine is 0.045 pooled ahead of it: of the engine's 0.062 pooled gain over the raw mean there, 0.017 is the flat judge's exclusion and 0.045 the leniency correction (with moderate bias, 0.015 and 0.026).
- Known-bad: an engine fed shifted project ids fails assertion (1) (mean within-track difference −0.961).

All of these are one-sided, so the raw mean passed off as the engine would pass them, as an outside reading pointed out. Two more make the engine show its gain, with margins set after these runs were seen, like (1c):

- **(4)** Where judges differ in leniency, the 95 % lower bound of the engine's gain over the raw mean with the flat judge out must be above about half the gain measured: 0.008 within-track and 0.012 pooled with moderate bias (measured 0.018 and 0.026), 0.020 for both in the batch confound (0.041 and 0.045). With noisy judges the halo swamps the leniency and there is no gain to assert.
- **(5)** Every other assertion is a mean over 1,000 runs, which would dilute one disastrous run, so in no single run of any scenario may the engine fall more than 0.20 below that raw mean (the worst measured is 0.136 below).
- Their known-bads: the engine with its leniency correction switched off (k = 10⁹) fails (4), its gain about zero, and one run in 1,000 turned upside down passes (4) and fails (5).

The engine's own self-test: planted leniency is recovered (`tests/normalize-oracle.test.ts`), and with none planted β̂² comes out at 0.0000.

**The ±** (`tests/normalize-errors.test.ts`) is checked on simulated events of 40 projects and 12 judges, with three reviews per project and 1,500 events per setting.

- With the variances known, 95 % intervals built from it cover the true project levels between 94 % and 96 % of the time (asserted), and the true leniencies between 93 % and 97 %. That holds for strong leniency (k = 1.6) and for the fixture's size of leniency (k = 43).
- With the variances estimated from each event's own scores, as the portal runs, the intervals cover projects 94.5 % (strong) and 94.4 % (fixture-like) of the time.
- They cover judges 93.0 % and 93.2 % of the time in the events where leniency is fitted: slightly short, because the two variances are themselves estimated from the same event's scores and that extra wobble is not in the ±.
- Its known-bad: a halved or a doubled ± fails the same check.

## Pairwise mode

An event can be judged by pairwise answers instead of rubric scores. This section says how judges answer, how the answers become a ranking, what the organizer sees and settles, and the proof.

The organizer switches the mode on Settings, with a reason, until results are published; after that the mode and every answer are final. Only the event's judges answer, and only an organizer sees the ranking or switches the mode; every refusal has a positive control (`tests/pairwise-dal.test.ts`).

**How a judge answers.** In this mode a judge never gives a number. They answer, about two of the projects they were given at a time, which is better: left, right, or "too close to call".

- Each project is placed into the judge's own ranked list, one at a time: the new project is compared with the middle of the range it can still take (binary insertion). So placing a project into a list of n takes at most ⌈log₂(n + 1)⌉ answers (tested) and six projects take at most eleven.
- "Too close to call" places it right below the project it tied with.
- The judge can take back their latest answer in a track, and its question comes back.

**One copy of the state.** The list and the next question are replayed from the judge's own answers on every read and every write, so there is no second copy of that state to drift.

- An answer is accepted only for the exact question the server would ask now (409 `question_changed`, nothing stored).
- Except: the judge's latest answer in the track sent again unchanged (a double click, a retry on a bad connection) is answered as taken and stays stored once (tested).
- An answer that no longer fits the replay (its project was merged away or left the judge's tracks) is skipped instead of breaking the list, so the judge's later answers still count (tested).

**Which side.** Which project sits on the left is a seeded coin per judge and question.

- The question (judge, project being placed, project it is compared with) is hashed into a seed for the portal's one seeded generator, the one the assignment runs and the signal check draw from. So a question asked again shows the same sides, and the new project is on the left in about half the questions.
- It is tested on the fixture's own ids that one question's side tells nothing about another's, across projects and across judges.
- The first version kept only the lowest bit of the hash, which is an XOR of one bit per id: on the fixture's ids, 8 of its 27 judges would have seen the new project on the same side in every question they could be asked, so for them the side pull and the pull of the project just opened could not be told apart.
- An answer stored with the sides the other way round (given under that first rule) still counts, read by the sides it was shown with (tested).

Why: a judge's scale stops being a problem by not existing. Normalization has to estimate each judge's leniency from the event's own scores; here the judge is never asked for a number, only for an order of the projects they were assigned, so there is no leniency to estimate and no 4 from one judge to set against a 3 from another.

The model: every project has a strength s, and the chance that the left project wins an answer is

    logit P(left wins) = s_left − s_right + h + ν · (+1 if the project just opened is on the left, −1 if on the right)

where h is the pull of the left side and ν the pull of the project the judge has just opened: the two ways the frame of a question could tilt an answer, both estimated from the event's own answers and reported with their ±.

- "Too close to call" counts as half a win each way.
- The priors are s ~ N(0, 2²), which also keeps a project that won everything finite, and h, ν ~ N(0, 0.5²).
- One fit over every comparison maximizes the log-posterior with Newton's method, which finds its one maximum because the log-posterior is concave; each strength's ± comes from the inverse of the negative Hessian at the maximum (the Laplace approximation).
- No comparison crosses tracks, so each Newton step and the ± are solved one track at a time with the two pulls eliminated (the Schur complement): the dense solve of the whole matrix gives the same answer to within 1e-9 (tested against it), and an event of 1,000 projects in 8 tracks fits in about 0.4 s where the dense solve took about 6 s.
- The engine is pure (it reads no database), so the same answers always give the same ranking.

**Why this model, and not Crowd-BT.** The organizers point to Gavel, which fits Crowd-BT: Bradley-Terry with a reliability number for each judge, fitted from the answers, that down-weights (or even reverses) a judge the model finds unreliable, and a next pair chosen for each judge to learn the most. We keep plain Bradley-Terry for three reasons:

1. **Reliability.** A judge here answers about log₂(k!) questions for k projects (eleven at most for six), too few to estimate a weight that quietly decides how much their word counts. So the portal measures each judge's agreement with the rest of the panel and flags, and the organizer decides with a written reason (the flag's error rates are measured in "The proof").
2. **Pair choice.** Judges here have an assigned batch (see "Assignment"), not a room to walk, so each judge places the projects they were given by binary search: every answer is used, the answers always form one consistent order per judge, and it takes about log₂(k!) of them.
3. **The frame of the question.** The two pulls, the side a project is shown on and the project just opened, are estimated and corrected for rather than assumed away (in part: the fit reads them low, see (c) under "The proof").

The ranking is global in the sense the bonus asks: one fit over every comparison in the event, from judges who each saw only part of it. It is reported per track because judges compare projects only within a track, so no answer links two tracks, and an order across them would be the prior's, not evidence (the same reason a track split into groups says so).

**What the organizer sees.** The organizer's Results tab shows, per track:

- **win %**, each project's chance of beating an average project of its track, σ(s − the track's mean strength), with a ± computed from the full covariance;
- **ahead of the next**, the chance this place really is ahead of the one below it, given only when the two are linked by comparisons;
- **groups**: projects joined through comparisons share a group, and a track split into groups says so, because nothing was measured across the gap; projects never compared come last;
- a **receipt** per project listing every comparison that entered the fit, judge by judge, with its result and weight.

The two pulls are shown in plain words ("the project shown on the left wins 56 % between two equal projects"), but only once each is known within 6 points. Before that the card says it is not measured yet, with the answer count and the current ±, because a pull read off a handful of answers is the prior's, not a finding. The fit corrects for its current estimate all the same; the 6-point gate only decides what is shown.

**Finished rubric reviews count too, as orders.** A judge's k reviews in one track say "this is my order of these k projects", and every two of them become a comparison, the higher total winning (equal totals: too close to call), each weighted 2/k.

- A judge's order of k projects so weighs k − 1 comparisons in total: their say grows with how many projects they ordered, not with its square (tested).
- A judge's answers replace their score order where they cover it: a pair implied by scores drops out once that judge has placed both of its projects by answers.
- Excluded judges (the flat-judge rule and the organizer's own decisions) are left out of the fit, and a merged duplicate counts for the copy kept.

**The coin-flip flag:** a judge with at least six answers whose answers agree with the rest of the panel no better than coin flips would (z below 0), or who calls "too close to call" more than half the time.

- Agreement is measured against a fit of everyone else's comparisons, each of the judge's answers weighted by how sure the rest of the panel is about that pair; a tie always earns half, so ties add nothing to the variance of z.
- How often it fires, on 120 simulated panels of the fixture's own assignments (`tests/pairwise-mc.test.ts`, check (e)): on 70 of 958 honest judges (7.3 %, held at or under 15 %), and on the judge who answers at random in 61 of 120 panels (51 %).
- A bar at z = 0 sits at a random judge's median, so the flag alone misses such a judge about half the time: it is a prompt for the organizer, not a detector. A higher bar would catch more random judges and flag more honest ones.
- The test holds that it fires on a random judge at least three times as often as on an honest one (7.0 times, measured).

**Before publishing,** the organizer settles, in the same list as the scores mode's decisions:

- each flagged judge, kept or left out with a written reason (a flag is a question for the organizer, never an automatic exclusion);
- each project that fewer than two judges compared, published as it is with a reason;
- any duplicate entry.

**Publishing** stores the run in the same tables as a score run (method `bradley-terry-v1`): the fitted win % where the normalized score goes, the plain share of comparisons won (ties half) where the raw mean goes, the ±, both ranks (average ranks, as in scores mode: equal values share a place, tested), and how many judges compared the project where the review count goes. The results page, the team's page, the records and the exports read a pairwise event like any other, and say how its places were made.

The fit stops after 100 Newton steps; on the sample event it settles in 6. Should it ever stop before settling, the organizer's Results tab and Publish panel say so and suggest more comparisons, publishing it as it is needs a written reason (409 `fit_not_settled` without one), and the reason is stored with the run, in the audit row and on the public results (tested).

In scores mode the organizer's Results tab carries the same engine as a cross-check: the event's reviews read only as each judge's order of the projects they reviewed, fitted as above, and set against the normalized order per track (Kendall's tau-b, 1 for the same order) with the projects whose places differ most. Because it never compares one judge's number with another's, no leniency can move it.

On the sample event it agrees at τ = 0.78 across tracks (0.33 to 1.00 per track; the lowest in the three-project Climate track), and it places the two copies of the project entered twice apart, as their different judges did.

### The proof

`tests/pairwise-mc.test.ts` builds simulated events on the fixture's real tracks and judge–project pairs. Every simulated judge places their assigned projects by binary insertion exactly as the Compare screen asks, with the sides the portal gives each question, answering from known project qualities, their own discrimination, and planted pulls h = 0.3 and ν = 0.2.

The assertions were declared before the first run (2026-09-27). Run it with `npx vitest run tests/pairwise-mc.test.ts --silent=false` (a few seconds); without `--silent=false` vitest runs it but prints nothing of the numbers below.

Two changes on 2026-09-29, both from an outside reading, moved these numbers:

1. **The score.** It is Kendall's tau-b against the true order, over pairs of projects in the same track, so a pair the estimate ties counts against it and a ranking that cannot tell two projects apart pays for that. The test used to drop tied pairs, which is Goodman-Kruskal gamma, and reported it under the name tau. The engine never ties two projects, so its figures did not move; the plain win rate often does (two projects that each won half their comparisons), and gamma had flattered it.
2. **The sides.** Each question's side now comes from a seeded coin (see "Pairwise mode" above), and since the simulated judges answer the sides the portal gives them, every simulated answer changed with it.

The same declared runs, step by step:

| | engine | win rate | difference | h | ν |
|---|---|---|---|---|---|
| (a) first run: gamma, one bit of a hash for the side | 0.680 | 0.678 | +0.002 | 0.241 | 0.141 |
| (a) tau-b, one bit of a hash | 0.680 | 0.668 | +0.011 | 0.241 | 0.141 |
| (a) tau-b, seeded coin (what ships) | 0.675 | 0.677 | −0.002 | 0.255 | 0.099 |
| (b) first run: gamma, one bit of a hash | 0.674 | 0.686 | −0.011 | | |
| (b) tau-b, one bit of a hash | 0.674 | 0.676 | −0.002 | | |
| (b) tau-b, seeded coin (what ships) | 0.677 | 0.679 | −0.002 | | |

- **(a)** Declared: the engine's mean Kendall tau with the true order is above the plain win rate's.
  - Measured over 200 runs with the pulls present: 0.675 (sd 0.089) against 0.677 (sd 0.087), a difference of −0.002 with a run-to-run sd of 0.044 (error of the mean 0.003). **The declared assertion now fails**, by less than one error of the mean. It stays as declared; the test marks it as failing (`it.fails`), so it turns red should it ever hold again.
  - To see whether the seed decides it, the test also reports eight blocks of 200 runs with the same pulls (not asserted, added after the failure was seen): the difference is 0.000 over 1,600 runs (error of the mean 0.001), the blocks ranging from −0.003 to +0.003. The same eight blocks under the old side rule also average 0.000, so the coin did not cost the engine anything; the declared seed's earlier pass (+0.002, then +0.011) was the luck of that seed.
  - The honest reading: at putting projects in order the engine **matches** the win rate, no better. What it adds is the two pulls measured and corrected for (in part, see (c)), a ± that is calibrated (d), the chance each place is ahead of the next, groups said out loud, the flag and the receipts.
  - Known-bad: the same fit with the projects' labels shuffled must fail (a); it scores a tau of −0.011.
- **(b)** With no pulls planted, 200 runs: engine 0.677, win rate 0.679, a difference of −0.002 (sd 0.041): the engine trails by no more than the run-to-run sd, as declared.
  - That margin is loose (the error of the mean over 200 runs is 0.003), so (b2), added after the third outside reading, asks for a 95 % lower bound above −0.020: measured −0.008. The margin was set after the first run was seen and stays where it was; it is there to fail on a regression.
  - Planted, on the same 200 runs and seeds (the test's "(b2) known-bad", which prints these figures): a strength prior eight times too tight (sd 0.25 for 2) costs the engine 0.017 (0.660) and (b2) fails it, difference −0.019, lower bound −0.025; the test asserts that it fails, and it turns red should (b2) ever stop catching it.
  - A prior four times too tight (sd 0.5) costs 0.007 (0.670) and **(b2) does not catch it**: difference −0.010, lower bound −0.015 (printed, not asserted). In the first run (gamma, the first side rule) that four-times defect cost 0.020 and (b2) caught it (lower bound −0.025, measured by hand at the time; the repository cannot reproduce it now). So (b2) guards against a gross regression only.
- **(c)** Declared: the mean pull estimates land within 0.1 of the truth. h 0.255 (true 0.3, sd 0.187) holds; **ν 0.099 (true 0.2, sd 0.196) fails, by 0.001**, and is marked failing like (a).
  - Over the 1,600 runs the fit reads both pulls low, h 0.230 (about a quarter low) and ν 0.129 (about a third low) (not looked into further; the prior N(0, 0.5²), which pulls toward zero, is one candidate).
  - The fit corrects every strength by the pulls it measured, so part of each real pull stays in the strengths, and the plain-words pull on the Results tab tends to understate the real one.
  - The balanced side coin (tested) keeps what stays of the side pull from favouring any one project; what stays of the just-opened pull depends on the order each judge opened their projects in, and how far that moves a place is not measured.
- **(d)** The 95 % intervals for win % cover the truth 0.951 of the time over 6,150 project-runs (declared window 90 to 99 %).
- **(e)** 120 panels, each with one judge answering at random and one answering honestly except that every answer their favourite would lose becomes "too close to call". The flag fires on 61 of 120 random answerers (50.8 %) and on 70 of 958 honest judges (7.3 %, declared bound 15 %). The strategic judge is not caught reliably: flagged in 14 of 120 panels, their ties bought the favourite 0.26 places on average, at most 3.

**Tried and not built: the engine choosing each judge's next question.** Instead of placing projects by binary insertion, the engine could ask each judge about the pair the panel is least sure of, weighted toward each track's top three.

It was simulated before any code, on the Monte Carlo's scenario (a), 400 runs per policy, against gates declared before the run:

- the right winner more often by at least 0.03 and by more than two standard errors;
- Kendall tau no worse by more than 0.01;
- no more answers than insertion;
- no more projects left with fewer than two judges.

Results:

- The version that could ship (each question fixed from the log as of the judge's previous answer, no repeated pair, every project asked about at least once, insertion's answer count) passed none of the accuracy gates: the right winner 0.014 more often (se 0.011, inside the noise), tau +0.010.
- A variant that refreshed its fit across all judges in rounds and kept asking about the top did clear the winner gate (+0.036, se 0.011), but only by leaving 1.7 % of projects compared by fewer than two judges.

The Compare screen keeps binary insertion. (These figures were measured before the score and side changes of 2026-09-29 described under "The proof", and were not re-run: the simulation that produced them is not in the repository.)

## Prizes

The engine decides places within each track; prizes are the organizers' own decision on top of them, made on the
Results tab before publishing with the places beside each project. The rule:

- A prize goes to one project, or jointly to several, with an optional note; a prize nobody is given stays
  unawarded, and publishing is allowed with prizes unawarded (the Publish panel says how many).
- Only the event's submitted projects can win (a submitted project never goes back to a draft), and a merged
  duplicate's copy cannot. A project that holds an award cannot be merged away into its other copy: the merge is
  refused (409 `prize_awarded`, "Take the award back first, then merge") and the refusal is logged; the kept copy
  may hold an award.
- Every award, change and taking back is one audited action, in the same transaction as the change.
- Publishing makes them final: the app refuses a change (409 `results_published`) and so does the database
  (`events_prize_awards_final`, and `prizes_final_*` for the prize list of an event that awarded one).
- The public results list each prize with its winners, each with its place in its track as published ("4th"), and the note; a winner's page and its team's certificates say
  "Winner, <prize>" ("Joint winner, <prize>" for a joint award). A place does not win a prize by itself: the first
  places stay as the engine placed them, and the prizes show beside them.
- An event that awards no prize publishes, exports and signs exactly what it did before prizes could be awarded.
## Finals

Bigger events judge in two rounds: everyone is scored, the best go to a final, and a panel judges the finalists. The portal runs that second round when the organizer asks for it (Finals tab). The first round, its tables and its rules are not touched.

**Who goes to the final.**

- The organizer opens finals for one track, or for every track at once with one panel, before publishing. Finals score on the rubric, so an event judged pairwise cannot open them (409 `pairwise_mode`): nothing there would lock the rubric the panel scores on.
- The top N of each track by first-round places become the finalists (N chosen, 3 unless set). First-round places are the live ranking the Results tab shows: the score engine's places (competition places, ties sharing the first of their places), or the pairwise fit's. Projects tied at the cut all go in.
- The organizer may add a finalist or take one off. Adding a project outside its track's top N, or taking off one inside it, goes against the ranking and needs a written reason. A round keeps at least two finalists.

**The panel.** At least two of the event's judges, named by the organizer. A panelist sees only the finalists of the rounds they sit on and only their own finals scores; asking the API for another panelist's is refused with 403, never answered with their own (the same rule as the first round's peer-scores route; `THREAT-MODEL.md`, "A panelist reading another panelist").

**Scoring.** Each panelist scores each finalist on the event's rubric: the same criteria, weights and scales as the first round, every criterion a whole number on its scale (the database refuses a value off the scale). Saving again replaces the panelist's own score. Only a panelist of the round scores, only its finalists, only while the round is open and the results unpublished.

**Conflicts of interest.** The first round's rules hold in the finals. A panelist never scores a finalist from their own team (403 `own_team`), nor one they declared a conflict on in the first round (403 `recused`); each refusal is audited. Such a pair is not waited for: closing counts only the pairs a panelist is free to score, and the Finals tab names each conflict. A score on such a pair, however it arose, does not count.

**The finals order.** A finalist's finals score is the plain mean, over the panelists on the panel now, of each panelist's weighted total (Σ weight × value ÷ Σ weight, as in the first round). No leniency correction is applied: when every panelist scores every finalist, a harsh or lenient panelist moves every finalist's mean by the same amount and cannot change their order. A finalist scored by only some panelists (a round closed early, or a conflict of interest) gets a mean that does not cancel a panelist's leniency: a lenient panelist who scored it and not another finalist lifts it against that one. **The ±.** Each finals score carries a ± of one standard error of that mean: the sample standard deviation of the counted panelists' weighted totals (dividing by n − 1) divided by √n. With one counted panelist nothing measures the spread and no ± is shown. It measures how far the panelists disagree, nothing else: unlike the first round's ± it holds no leniency estimate, since none is fitted. The public results, the overall order, the first-place tile, the Finals tab and `finals.csv` (`finals_se`) show it next to every finals score. A score by someone the organizer has since taken off the panel stays stored and does not count. Once any finals score exists, a change of the panel needs a written reason, kept in its audit row and shown on the public results. A panelist the organizer removes from the judges (`judge.remove`) or leaves out of the ranking (an exclude override, `judge.override`) is treated as in the first round: their finals scores stay on record but out of the finals order, the Finals tab names them, and closing does not wait for them. Finalists are ordered by finals score, highest first. An exactly equal finals score is broken by the event's tie-break criterion when one is set ("Breaking exact ties"), read from the panel's own scores: each finalist's plain mean on that criterion over the same counted finals scores, higher first; finalists equal on that too, or any equal finals score in an event with no tie-break, share a joint place. The projects below the finalists keep the first round's tie-break among themselves. A finalist nobody on the panel scored (possible only when the round was closed early) comes after the scored finalists, in first-round order.

**Closing.** The organizer closes the round once every counted panelist has scored every finalist they are free to score, or earlier with a written reason, which the public results show; the note on the public results then no longer says every panelist scored every finalist. A round closed with fewer than two counted panelists (the others removed or left out after scoring) would let one judge decide the finals: closing it needs a written reason too (409 `too_few_counted` without one), and the public results say how many panelists' scores count. For the same reason a judge left out of the ranking cannot join a panel (409 `judge_left_out`: restore the judge first); a panelist already on it who is removed or left out may stay, and their scores stop counting. Publishing is refused (409 `finals_open`) while any round is open.

**The published places of a track that held finals.** The finalists first, in the finals order; then everyone else in first-round order, their places counted on after the finalists' (with three finalists, the best non-finalist is 4th). The public results mark the track "Finals", say how the places were reached (and "How this ranking was reached" says in how many tracks a finals panel decided the top places), show each finalist's finals score with its ± and panel count next to their first-round score, and list each finalist the organizer added or took off against the ranking with its reason and date, as weight changes and track moves are listed. When the finals decided a track's first place, its tile in "First places" shows the finals score. A tie the tie-break split in the finals reads "Tied in the finals; tie broken by …", one below the finalists "Tied on score; tie broken by …". The overall order across tracks gives each project this same published place in its track and marks a finalist's place as the finals'. A certificate names the published place. A track without finals, and an event without finals, publish exactly as before.

**Frozen by publishing.** The finals tables (`finals`, `finalists`, `finals_panel`, `finals_scores`, `finals_score_items`; `DATA-MODEL.md`) take no insert, update or delete once the event's results are published, enforced by the database's triggers as for the first round.

Every step (open, a finalist added or taken off, the panel, each score, the close) is one audited change; a webhook delivery of the opening carries only the track and N, of a score only the round and project, of the close only the missing count and reason, so no first-round place or finals score leaves the portal before publishing; `finals.csv` exports every finals score and each finalist's finals score, its ± (`finals_se`) and its place (`finals_place`: once the results are published, the published place in its track, the one the results page, certificates and `normalized.csv` show, the tie-break included; before, the place by finals score alone within its track), and `event.json` carries the finals rows. After publishing, `normalized.csv` of an event that held finals gains `track_place` (the published place, the one the results page and certificates show; with a tie-break it is already there) and `finals_score` (empty for a non-finalist); `track_rank` stays the engine's first-round average rank. In the results API every row's `place` is the published place with a shared place given as the mean of the places it spans (two joint 1st: 1.5), with or without finals.

## The audit trail

This section says what the audit log records, what protects it, and where that protection stops.

**What is written.** Every change is written in the same database transaction as the change, and so is every refusal of someone the portal knows: a signed-in person or a voter holding a link (403).

- A request with no valid session (401) leaves no row, since anyone can make those without end.
- Past 60 refusals in 10 minutes a person is answered 429 with no row, so one account cannot fill the log.

**What protects it.**

- Triggers refuse UPDATE and DELETE on the log, and a new row that does not link to the last one or would take an existing row's place, and they are re-created at every start.
- Each row carries the hash of the row before it. The organizer's audit page and `audit.csv` show the head hash with its row number, the pair a signed record pins, and the check reports rows missing when the ids SQLite gave audit rows skip or run past the last row.
- A hash never gives away what its row keeps from a reader: the row of a ballot, a score or a pairwise answer is hashed with its own random salt, shown in `audit.csv` only together with the values (a ballot's once voting closes) and never sent in a webhook, so nobody can hash guessed picks or scores to find the one that matches. Once shown, the row can be recomputed from its own line (`DATA-MODEL.md`, the chain).

**Limits, stated plainly:** the triggers stop the application, not someone holding the database file; the chain is tamper-evident only against a head hash kept outside the portal.

- The portal spreads such heads as it goes: each signed certificate and judging record carries the newest entry's number and hash inside its signature (the record's page says whether the log still holds that entry as signed), and the public results page shows the entry that published the results (for an event imported already published there is none on this portal: its publication is in the import's audit row, as `DATA-MODEL.md` and `docs/OPERATIONS.md` say).
- The signing key itself is sealed under the portal's secret, so with your own `DOGFOOD_SEED_SECRET` a copy of the database cannot sign new records to match a rewritten log (under the documented default anyone can derive the sealing key, which is why the portal runs on it only as the local demo; `DATA-MODEL.md`, `signing_keys`).

## Threat model

In its own file, `THREAT-MODEL.md`: Sybil votes, ballot stuffing, submission scraping, judge collusion, deadline gaming, tactical pairwise answers, forged requests, filling the audit log and rewriting the record, each with what is stopped and what is not.

## What it does not do

- **No calibrated prize probabilities or rank intervals:** each score carries a ± of one standard error, and the portal does not turn it into rank intervals or prize odds, on any page or in any API answer. The one reading it makes of the ± is the close-call rule's yes/no at the validated 95 % line, with the close projects named by score and ±. A method that produced prize odds was tried in planning and cut: on simulated events with no real differences it named a 50 %+ favourite in 46 of 80 tracks (planning simulation of 2026-09-24, not re-run in this repository).
- **Places are decided within a track;** the overall ranking (the public page `/events/{event}/results/overall` in scores mode, the organizer's table, and the table above) is a convenience view, since tracks compare only through judges who score in both, so read the order across tracks loosely.
- **With few reviews per judge the engine corrects little,** by design.
- **No automatic cross-track assignment.**
