#!/usr/bin/env python3
"""DOGFOOD 2026 isolation hand-check.

Usage:  python tests/isolation_check.py [.dogfood.toml]

Any Python 3.11+. Standard library only, nothing to install.

Section A walks each role (visitor, participant, judge_a, judge_b, organizer)
through the judging APIs and accepts only real 4xx refusals — the opener never
follows a redirect, so a redirect to a login page shows as a 3xx and fails the
check. Section B exercises the T3 features: community voting through all three
ways in, duplicate detection, voiding, comment moderation and rate limits.

This check WRITES data: votes, comments and the event's voting settings. Run it
on a fresh instance, after run.py, and never on one whose data you care about.
"""

import argparse
import csv
import io
import json
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar

import tomllib  # Python 3.11 and newer

TIMEOUT = 10
EVENT_ID = "evt_01"
EVENT_SLUG = "sample-hack-2026"
VOTE_COOKIE = f"vote_{EVENT_ID}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A refusal must be a real 4xx: never follow a redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Person:
    """One identity: an auth header (or none) and its own cookie jar."""

    def __init__(self, name, header=None):
        self.name = name
        self.header = header
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.jar)
        )

    def request(self, method, url, body=None, headers=None):
        """Return (status, text, headers). Never raises on an HTTP error status."""
        req = urllib.request.Request(url, method=method)
        if self.header:
            name, _, value = self.header.partition(":")
            req.add_header(name.strip(), value.strip())
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        if body is not None:
            req.data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=TIMEOUT) as resp:
                return resp.status, resp.read().decode("utf-8", "replace"), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace"), e.headers
        except Exception as e:
            return 0, f"{type(e).__name__}: {e}", {}

    def has_cookie(self, name):
        return any(c.name == name for c in self.jar)


class Check:
    """One assertion group. Collects its own failure detail as it runs."""

    def __init__(self, section, label):
        self.section = section
        self.label = label
        self.ok = True
        self.skipped = False
        self.detail = []

    def note(self, line):
        self.detail.append(line)


def as_json(text):
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        return {}


def error_code(text):
    return as_json(text).get("error")


def expect(c, ok, person, method, url, got, wanted):
    """Fold one sub-assertion into the check, noting how it failed."""
    if ok:
        return True
    c.ok = False
    c.note(f"{method} {url}")
    c.note(f"sent as {person.name}")
    c.note(f"got {got}, wanted {wanted}")
    return False


def utc_minute(dt):
    """A datetime as the "YYYY-MM-DDTHH:MM" the settings PUT takes (UTC)."""
    return dt.strftime("%Y-%m-%dT%H:%M")


def run_checks(cfg):
    base = cfg["portal"]["base_url"].rstrip("/")
    auth = cfg.get("auth", {})

    def u(path):
        return base + path

    now = datetime.now(timezone.utc)
    open_soon = utc_minute(now - timedelta(hours=1))
    close_soon = utc_minute(now + timedelta(days=1))
    open_past = utc_minute(now - timedelta(days=2))
    close_past = utc_minute(now - timedelta(minutes=1))

    # The five identities of Section A; the browsers are fresh cookie jars.
    visitor = Person("a visitor with no cookie")
    participant = Person("the participant", auth.get("participant"))
    judge_a = Person("judge_a", auth.get("judge_a"))
    judge_b = Person("judge_b", auth.get("judge_b"))
    organizer = Person("the organizer", auth.get("organizer"))
    link_a = Person("the first link-voting browser")
    link_b = Person("the second link-voting browser")
    listed = Person("the listed voter's browser")
    anon = Person("an anonymous rate-probe browser")

    checks = []

    # ======================= Section A: role isolation =======================

    # A1 -- whose scores each role may read
    c = Check("A", "judge scores by role")
    scores_url = u("/api/judge/scores")
    s, body, _ = visitor.request("GET", scores_url)
    expect(c, s == 401, visitor, "GET", scores_url, s, "401")
    s, body, _ = participant.request("GET", scores_url)
    expect(c, s == 403, participant, "GET", scores_url, s, "403")
    s, body, _ = organizer.request("GET", scores_url)
    expect(c, s == 403, organizer, "GET", scores_url, s, "403")
    s, body, _ = judge_a.request("GET", scores_url)
    ok = s == 200
    if not expect(c, ok, judge_a, "GET", scores_url, s, "200"):
        judge_a_id, judge_a_ids = "", []
    else:
        data = as_json(body)
        judge_a_id = data.get("judge", {}).get("id", "")
        reviews = data.get("reviews", [])
        judge_a_ids = [r.get("assignmentId", "") for r in reviews]
        if not judge_a_id:
            c.note(f"GET {scores_url}")
            c.note("sent as judge_a")
            c.note(f"200 but judge.id is missing: {body[:200]}")
            c.ok = False
        if not judge_a_ids:
            c.note(f"GET {scores_url}")
            c.note("sent as judge_a")
            c.note("200 but no reviews came back; need at least one assignmentId")
            c.ok = False
    s, body, _ = judge_b.request("GET", scores_url)
    if expect(c, s == 200, judge_b, "GET", scores_url, s, "200"):
        other = as_json(body).get("judge", {}).get("id", "")
        if not other or other == judge_a_id:
            c.note(f"GET {scores_url}")
            c.note("sent as judge_b")
            c.note(f"judge.id {other!r} is not a different judge than judge_a's {judge_a_id!r}")
            c.ok = False
    checks.append(c)

    # A2 -- asking for judge_a's scores by id
    c = Check("A", "peer scores refused, never handed out")
    peer_url = u(f"/api/judge/scores?judge={judge_a_id}")
    s, body, _ = judge_a.request("GET", peer_url)
    expect(c, s == 200, judge_a, "GET", peer_url, s, "200 (asking for own id)")
    s, body, _ = judge_b.request("GET", peer_url)
    if expect(c, s == 403, judge_b, "GET", peer_url, s, "403"):
        leaked = [a for a in judge_a_ids if a and a in body]
        if leaked:
            c.note(f"GET {peer_url}")
            c.note("sent as judge_b; refused with 403, but the body leaks ids")
            c.note("assignment ids found in the body: " + ", ".join(leaked))
            c.ok = False
    s, _, _ = participant.request("GET", peer_url)
    expect(c, s == 403, participant, "GET", peer_url, s, "403")
    s, _, _ = visitor.request("GET", peer_url)
    expect(c, s == 401, visitor, "GET", peer_url, s, "401")
    checks.append(c)

    # A3 -- saving a review of one of judge_a's assignments
    c = Check("A", "review save honours the assignment's judge")
    assignment = judge_a_ids[0] if judge_a_ids else "none"
    review_url = u(f"/api/judge/reviews/{assignment}")
    s, body, _ = judge_a.request("PUT", review_url, {})
    code = error_code(body)
    if s == 403 and code not in ("judging_closed", "results_published"):
        expect(c, False, judge_a, "PUT", review_url, f"{s} ({code})", "200, or 403 judging_closed/results_published")
    else:
        expect(c, s in (200, 403), judge_a, "PUT", review_url, s, "200, or 403 judging_closed/results_published")
    s, body, _ = judge_b.request("PUT", review_url, {})
    code = error_code(body)
    if not expect(c, s == 403, judge_b, "PUT", review_url, s, "403"):
        pass
    else:
        expect(c, code == "not_your_assignment", judge_b, "PUT", review_url, f"error {code!r}", "error 'not_your_assignment'")
    s, _, _ = participant.request("PUT", review_url, {})
    expect(c, s == 403, participant, "PUT", review_url, s, "403")
    s, _, _ = visitor.request("PUT", review_url, {})
    expect(c, s == 401, visitor, "PUT", review_url, s, "401")
    checks.append(c)

    # A4 -- the aggregate exports
    c = Check("A", "score exports are organizer-only")
    for name in ("scores.csv", "normalized.csv"):
        url = u(f"/api/events/{EVENT_ID}/export/{name}")
        s, body, _ = organizer.request("GET", url)
        first = body.splitlines()[0] if body.splitlines() else ""
        if expect(c, s == 200, organizer, "GET", url, s, "200"):
            expect(c, "," in first, organizer, "GET", url, f"a first line with no comma in it ({first[:60]!r})", "a CSV header with commas")
        s, _, _ = judge_a.request("GET", url)
        expect(c, s == 403, judge_a, "GET", url, s, "403")
        s, _, _ = participant.request("GET", url)
        expect(c, s == 403, participant, "GET", url, s, "403")
        s, _, _ = visitor.request("GET", url)
        expect(c, s == 401, visitor, "GET", url, s, "401")
    checks.append(c)

    # A5 -- the audit log, CSV and page
    c = Check("A", "audit log is organizer-only")
    audit_url = u(f"/api/events/{EVENT_ID}/export/audit.csv")
    s, body, _ = organizer.request("GET", audit_url)
    first = body.splitlines()[0] if body.splitlines() else ""
    if expect(c, s == 200, organizer, "GET", audit_url, s, "200"):
        expect(c, "hash" in first.lower(), organizer, "GET", audit_url, f"header with no hash column ({first[:60]!r})", "a header containing 'hash'")
    s, _, _ = judge_a.request("GET", audit_url)
    expect(c, s == 403, judge_a, "GET", audit_url, s, "403")
    s, _, _ = participant.request("GET", audit_url)
    expect(c, s == 403, participant, "GET", audit_url, s, "403")
    s, _, _ = visitor.request("GET", audit_url)
    expect(c, s == 401, visitor, "GET", audit_url, s, "401")
    page_url = u(f"/organize/{EVENT_SLUG}/audit")
    s, _, _ = organizer.request("GET", page_url)
    expect(c, s == 200, organizer, "GET", page_url, s, "200")
    s, _, _ = judge_a.request("GET", page_url)
    expect(c, s == 403, judge_a, "GET", page_url, s, "403")
    s, _, _ = visitor.request("GET", page_url)
    expect(c, s == 401, visitor, "GET", page_url, s, "401")
    checks.append(c)

    # A6 -- the judge console page
    c = Check("A", "judge console is the event's judges' page")
    console_url = u(f"/judge/{EVENT_SLUG}")
    s, _, _ = judge_a.request("GET", console_url)
    expect(c, s == 200, judge_a, "GET", console_url, s, "200")
    s, _, _ = participant.request("GET", console_url)
    expect(c, s == 403, participant, "GET", console_url, s, "403")
    s, _, _ = organizer.request("GET", console_url)
    expect(c, s == 403, organizer, "GET", console_url, s, "403")
    s, _, _ = visitor.request("GET", console_url)
    expect(c, s == 401, visitor, "GET", console_url, s, "401")
    checks.append(c)

    # A7 -- fixing the judging set-up is the organizers' alone. Refusals only, plus
    # organizer requests that change nothing, so the later sections see the same event.
    c = Check("A", "judging set-up fixes are organizer-only")
    ranking_url = u(f"/api/events/{EVENT_ID}/judge-ranking")
    for person, wanted in ((visitor, 401), (participant, 403), (judge_a, 403), (judge_b, 403)):
        s, _, _ = person.request("PUT", ranking_url, {"show": False})
        expect(c, s == wanted, person, "PUT", ranking_url, s, str(wanted))
    s, body, _ = organizer.request("PUT", ranking_url, {"show": True})
    if expect(c, s == 200, organizer, "PUT", ranking_url, s, "200 (showing what is already shown)"):
        expect(c, as_json(body).get("changed") is False, organizer, "PUT", ranking_url, f"changed {as_json(body).get('changed')!r}", "changed False")
    held = judge_a_ids[0] if judge_a_ids else "none"
    remove_url = u(f"/api/events/{EVENT_ID}/assignments/{held}/remove")
    unrecuse_url = u(f"/api/events/{EVENT_ID}/assignments/{held}/undo-recusal")
    for url in (remove_url, unrecuse_url):
        for person, wanted in ((visitor, 401), (participant, 403), (judge_a, 403), (judge_b, 403)):
            s, _, _ = person.request("POST", url, {"reason": "isolation probe"})
            expect(c, s == wanted, person, "POST", url, s, str(wanted))
    # the organizer passes the gate: an empty reason is the 422 behind it, and nothing changes
    s, _, _ = organizer.request("POST", remove_url, {"reason": ""})
    expect(c, s == 422, organizer, "POST", remove_url, s, "422 (past the gate, no reason given)")
    s, body, _ = organizer.request("POST", unrecuse_url, {"reason": "isolation probe"})
    expect(c, s == 200, organizer, "POST", unrecuse_url, s, "200 (a review that is not recused: nothing changes)")
    remove_judge_url = u(f"/api/events/{EVENT_ID}/judges/{judge_a_id or 'none'}/remove")
    for person, wanted in ((visitor, 401), (participant, 403), (judge_b, 403)):
        s, _, _ = person.request("POST", remove_judge_url, {"reason": "isolation probe"})
        expect(c, s == wanted, person, "POST", remove_judge_url, s, str(wanted))
    s, _, _ = organizer.request("POST", remove_judge_url, {"reason": ""})
    expect(c, s == 422, organizer, "POST", remove_judge_url, s, "422 (past the gate, no reason given)")
    batch_url = u(f"/api/events/{EVENT_ID}/judges/invites/batch")
    for person, wanted in ((visitor, 401), (participant, 403), (judge_a, 403)):
        s, _, _ = person.request("POST", batch_url, {"lines": "Probe, probe@example.org", "trackIds": []})
        expect(c, s == wanted, person, "POST", batch_url, s, str(wanted))
    s, _, _ = organizer.request("POST", batch_url, {"lines": "", "trackIds": []})
    expect(c, s == 422, organizer, "POST", batch_url, s, "422 (past the gate, an empty list makes nothing)")
    move_url = u(f"/api/events/{EVENT_ID}/projects/prj_01/track")
    for person, wanted in ((visitor, 401), (participant, 403), (judge_a, 403)):
        s, _, _ = person.request("POST", move_url, {"trackId": "trk_02", "reason": "isolation probe"})
        expect(c, s == wanted, person, "POST", move_url, s, str(wanted))
    s, _, _ = organizer.request("POST", move_url, {"trackId": "trk_02", "reason": ""})
    expect(c, s == 422, organizer, "POST", move_url, s, "422 (past the gate, no reason given)")
    judging_url = u(f"/api/events/{EVENT_ID}/projects/prj_01/judging")
    s, _, _ = organizer.request("GET", judging_url)
    expect(c, s == 200, organizer, "GET", judging_url, s, "200")
    for person, wanted in ((visitor, 401), (participant, 403), (judge_a, 403)):
        s, _, _ = person.request("GET", judging_url)
        expect(c, s == wanted, person, "GET", judging_url, s, str(wanted))
    checks.append(c)

    # ================= Section B: T3 community voting & comments =================

    # B1 -- open a window as the organizer, and only as the organizer
    c = Check("B", "voting settings are organizer-only")
    settings = {"votingOpenAt": open_soon, "votingCloseAt": close_soon,
                "modes": ["account", "listed", "link"], "votesPerVoter": 3}
    settings_url = u(f"/api/events/{EVENT_ID}/voting")
    s, body, _ = organizer.request("PUT", settings_url, settings)
    expect(c, s == 200, organizer, "PUT", settings_url, s, "200")
    s, _, _ = participant.request("PUT", settings_url, settings)
    expect(c, s == 403, participant, "PUT", settings_url, s, "403")
    checks.append(c)

    # B2 -- while the window is open the count is for organizers only
    c = Check("B", "tally hidden from everyone but organizers while voting is open")
    community_url = u(f"/api/events/{EVENT_ID}/community")
    for person in (visitor, participant, organizer):
        s, body, _ = person.request("GET", community_url)
        if expect(c, s == 200, person, "GET", community_url, s, "200"):
            expect(c, as_json(body).get("tally") is None, person, "GET", community_url,
                   f"tally {as_json(body).get('tally')!r}", "tally null while open")
    s, _, _ = participant.request("GET", settings_url)
    expect(c, s == 403, participant, "GET", settings_url, s, "403")
    s, _, _ = visitor.request("GET", settings_url)
    expect(c, s == 401, visitor, "GET", settings_url, s, "401")
    s, body, _ = organizer.request("GET", settings_url)
    if expect(c, s == 200, organizer, "GET", settings_url, s, "200"):
        live = as_json(body).get("tally")
        expect(c, isinstance(live, list) and len(live) > 0 and all(t.get("votes") == 0 for t in live),
               organizer, "GET", settings_url, f"tally {str(live)[:80]}", "the live count, all 0 before any ballot")
    checks.append(c)

    # B3 -- the account ballot
    c = Check("B", "ballot saves obey the voter and the limit")
    ballot_url = u(f"/api/events/{EVENT_ID}/ballot")
    s, _, _ = visitor.request("PUT", ballot_url, {"projectIds": ["prj_01"]})
    expect(c, s == 401, visitor, "PUT", ballot_url, s, "401 without a session or link")
    s, _, _ = participant.request("PUT", ballot_url, {"projectIds": ["prj_02", "prj_03", "prj_04", "prj_05"]})
    expect(c, s == 422, participant, "PUT", ballot_url, s, "422 over the limit of 3")
    # the participant's own team made prj_01: no vote for it
    s, _, _ = participant.request("PUT", ballot_url, {"projectIds": ["prj_01", "prj_02"]})
    expect(c, s == 422, participant, "PUT", ballot_url, s, "422 for a pick of their own team's project")
    s, body, _ = participant.request("PUT", ballot_url, {"projectIds": ["prj_02", "prj_06"]})
    expect(c, s == 200, participant, "PUT", ballot_url, s, "200 with two picks")
    s, body, _ = participant.request("GET", ballot_url)
    if expect(c, s == 200, participant, "GET", ballot_url, s, "200"):
        data = as_json(body)
        expect(c, data.get("picks") == ["prj_02", "prj_06"], participant, "GET", ballot_url,
               f"picks {data.get('picks')!r}", "picks ['prj_02', 'prj_06'] (the refused save changed nothing)")
        expect(c, (data.get("voter") or {}).get("kind") == "account", participant, "GET", ballot_url,
               f"voter {(data.get('voter') or {}).get('kind')!r}", "voter.kind 'account'")
    checks.append(c)

    # B4 -- the open link: one code in, two browsers out, different shuffles
    c = Check("B", "open link voters each get their own ballot")
    link_url = u(f"/api/events/{EVENT_ID}/voting/link")
    s, body, _ = organizer.request("POST", link_url)
    code = link_a_id = link_b_id = None
    if expect(c, s == 201, organizer, "POST", link_url, s, "201"):
        code = as_json(body).get("code")
        expect(c, bool(code), organizer, "POST", link_url, f"no code in the body ({body[:120]!r})", "a code")
    orders = {}
    voter_ids = {}
    if code:
        for person in (link_a, link_b):
            s, body, _ = person.request("POST", u(f"/api/vote/{code}"))
            expect(c, s == 200, person, "POST", u(f"/api/vote/{code}"), s, "200")
            expect(c, person.has_cookie(VOTE_COOKIE), person, "POST", u(f"/api/vote/{code}"),
                   f"no {VOTE_COOKIE} cookie in the jar", f"a {VOTE_COOKIE} cookie")
            s, body, _ = person.request("GET", ballot_url)
            if expect(c, s == 200, person, "GET", ballot_url, s, "200"):
                data = as_json(body)
                projects = [p.get("id") for p in data.get("projects", [])]
                expect(c, len(projects) == 41, person, "GET", ballot_url,
                       f"{len(projects)} projects", "41 projects")
                voter = data.get("voter") or {}
                expect(c, bool(voter.get("id")), person, "GET", ballot_url,
                       f"voter {voter!r}", "a voter id")
                orders[person.name] = projects
                voter_ids[person.name] = voter.get("id")
        order_a = orders.get(link_a.name)
        order_b = orders.get(link_b.name)
        if order_a and order_b:
            expect(c, order_a != order_b, link_b, "GET", ballot_url,
                   "both browsers got the same project order", "a different shuffle per ballot")
        link_a_id = voter_ids.get(link_a.name)
        link_b_id = voter_ids.get(link_b.name)
        s, _, _ = link_a.request("PUT", ballot_url, {"projectIds": ["prj_03"]})
        expect(c, s == 200, link_a, "PUT", ballot_url, s, "200 for one pick")
        s, _, _ = link_b.request("PUT", ballot_url, {"projectIds": ["prj_04"]})
        expect(c, s == 200, link_b, "PUT", ballot_url, s, "200 for one pick")
    checks.append(c)

    # B5 -- the organizer sees the two link browsers as one suspected group, and the live count,
    # with the open link's ballots in their own column; whether they count is fixed by now
    c = Check("B", "duplicate voters flagged, and the count live, for the organizer only; the open link counted apart")
    s, body, _ = organizer.request("GET", settings_url)
    found = False
    if expect(c, s == 200, organizer, "GET", settings_url, s, "200"):
        groups = as_json(body).get("suspected", [])
        for g in groups:
            ids = {v.get("id") for v in g.get("voters", [])}
            if link_a_id in ids and link_b_id in ids:
                found = True
                break
        expect(c, found, organizer, "GET", settings_url,
               f"no suspected group holds both link voters ({link_a_id!r}, {link_b_id!r})",
               "one group with both link voters in it")
        # the organizer's count is live: the account ballot counts, and the two open-link
        # ballots show in their own column without adding to it (the default)
        live = {t.get("projectId"): (t.get("votes"), t.get("openLink")) for t in as_json(body).get("tally") or []}
        got = (live.get("prj_02"), live.get("prj_03"), live.get("prj_04"))
        expect(c, got == ((1, 0), (0, 1), (0, 1)), organizer, "GET", settings_url,
               f"live (votes, openLink) for prj_02/03/04 = {got!r}", "((1, 0), (0, 1), (0, 1))")
    # with ballots in, whether open-link ballots count can no longer change ...
    s, body, _ = organizer.request("PUT", settings_url, dict(settings, countLink=True))
    if expect(c, s == 409, organizer, "PUT", settings_url, s, "409 once ballots are in"):
        expect(c, error_code(body) == "count_rule_fixed", organizer, "PUT", settings_url,
               f"code {error_code(body)!r}", "code 'count_rule_fixed'")
    # ... while a save that leaves it as it is still goes through (positive control)
    s, _, _ = organizer.request("PUT", settings_url, settings)
    expect(c, s == 200, organizer, "PUT", settings_url, s, "200 for the same settings")
    s, body, _ = visitor.request("GET", community_url)
    if expect(c, s == 200, visitor, "GET", community_url, s, "200"):
        expect(c, as_json(body).get("tally") is None, visitor, "GET", community_url,
               f"tally {str(as_json(body).get('tally'))[:80]}", "still null for everyone else, with ballots in")
    checks.append(c)

    # B6 -- the voter list: a personal link in, a 'listed' ballot
    c = Check("B", "listed voters enter by personal link")
    voters_url = u(f"/api/events/{EVENT_ID}/voting/voters")
    email = f"iso-{secrets.token_hex(4)}@example.org"
    s, body, _ = organizer.request("POST", voters_url, {"emails": email})
    path = token = None
    if expect(c, s == 201, organizer, "POST", voters_url, s, "201"):
        links = as_json(body).get("links", [])
        if expect(c, len(links) == 1, organizer, "POST", voters_url, f"{len(links)} links", "one link"):
            path = links[0].get("path", "")
            expect(c, path.startswith("/vote/"), organizer, "POST", voters_url,
                   f"path {path!r}", "a path starting with /vote/")
            token = path[len("/vote/"):] if path.startswith("/vote/") else ""
    if token:
        s, _, _ = listed.request("POST", u(f"/api/vote/{token}"))
        expect(c, s == 200, listed, "POST", u(f"/api/vote/{token}"), s, "200")
        s, _, _ = listed.request("PUT", ballot_url, {"projectIds": ["prj_05"]})
        expect(c, s == 200, listed, "PUT", ballot_url, s, "200 for one pick")
        s, body, _ = listed.request("GET", ballot_url)
        if expect(c, s == 200, listed, "GET", ballot_url, s, "200"):
            expect(c, (as_json(body).get("voter") or {}).get("kind") == "listed", listed, "GET", ballot_url,
                   f"voter {(as_json(body).get('voter') or {}).get('kind')!r}", "voter.kind 'listed'")
    checks.append(c)

    # B7 -- set the first link browser's ballot aside
    c = Check("B", "a voided ballot stops counting and stops voting")
    void_url = u(f"/api/events/{EVENT_ID}/voting/voters/{link_a_id}/void")
    s, body, _ = organizer.request("POST", void_url, {"reason": "isolation check: same browser"})
    expect(c, s == 200, organizer, "POST", void_url, s, "200")
    s, body, _ = link_a.request("PUT", ballot_url, {"projectIds": ["prj_03"]})
    if expect(c, s == 403, link_a, "PUT", ballot_url, s, "403 once voided"):
        expect(c, error_code(body) == "voter_voided", link_a, "PUT", ballot_url,
               f"error {error_code(body)!r}", "error 'voter_voided'")
    s, _, _ = participant.request("POST", void_url, {"reason": "isolation check: not mine to do"})
    expect(c, s == 403, participant, "POST", void_url, s, "403")
    checks.append(c)

    # B8 -- comments and moderation
    c = Check("B", "comments: post, hide, the reason stays, unhide, and only the author deletes")
    comments_url = u("/api/projects/prj_01/comments")
    s, _, _ = visitor.request("POST", comments_url, {"body": "isolation check: no session"})
    expect(c, s == 401, visitor, "POST", comments_url, s, "401")
    s, body, _ = participant.request("POST", comments_url, {"body": "isolation check: first comment"})
    comment_id = None
    if expect(c, s == 201, participant, "POST", comments_url, s, "201"):
        comment_id = as_json(body).get("id")
        expect(c, bool(comment_id), participant, "POST", comments_url,
               f"no id in the body ({body[:120]!r})", "an id")
    if comment_id:
        hide_url = u(f"/api/comments/{comment_id}/hide")
        s, _, _ = organizer.request("POST", hide_url, {"reason": "isolation check"})
        expect(c, s == 200, organizer, "POST", hide_url, s, "200")
        s, _, _ = participant.request("POST", hide_url, {"reason": "isolation check"})
        expect(c, s == 403, participant, "POST", hide_url, s, "403")
        s, body, _ = participant.request("GET", comments_url)
        row = None
        if expect(c, s == 200, participant, "GET", comments_url, s, "200"):
            row = next((x for x in as_json(body).get("comments", []) if x.get("id") == comment_id), None)
        if expect(c, row is not None, participant, "GET", comments_url,
                  f"comment {comment_id} not in the list", "the comment in the list"):
            expect(c, row.get("body") is None, participant, "GET", comments_url,
                   f"body {row.get('body')!r}", "body null once hidden")
            expect(c, (row.get("hidden") or {}).get("reason") == "isolation check", participant,
                   "GET", comments_url, f"hidden {row.get('hidden')!r}",
                   "hidden.reason 'isolation check'")
        # a hidden comment stays until the organizers unhide it; then only its author deletes it
        delete_url = u(f"/api/comments/{comment_id}")
        s, body, _ = participant.request("DELETE", delete_url)
        expect(c, s == 403 and error_code(body) == "comment_hidden", participant, "DELETE", delete_url,
               f"{s} {error_code(body)}", "403 comment_hidden")
        unhide_url = u(f"/api/comments/{comment_id}/unhide")
        s, _, _ = participant.request("POST", unhide_url)
        expect(c, s == 403, participant, "POST", unhide_url, s, "403")
        s, _, _ = organizer.request("POST", unhide_url)
        expect(c, s == 200, organizer, "POST", unhide_url, s, "200")
        s, _, _ = visitor.request("DELETE", delete_url)
        expect(c, s == 401, visitor, "DELETE", delete_url, s, "401")
        s, body, _ = judge_a.request("DELETE", delete_url)
        expect(c, s == 403 and error_code(body) == "not_your_comment", judge_a, "DELETE", delete_url,
               f"{s} {error_code(body)}", "403 not_your_comment")
        s, _, _ = participant.request("DELETE", delete_url)
        expect(c, s == 200, participant, "DELETE", delete_url, s, "200")
        s, body, _ = participant.request("GET", comments_url)
        if expect(c, s == 200, participant, "GET", comments_url, s, "200"):
            gone = all(x.get("id") != comment_id for x in as_json(body).get("comments", []))
            expect(c, gone, participant, "GET", comments_url, f"comment {comment_id} still listed",
                   "the deleted comment gone")
    checks.append(c)

    # B9 -- the rate limits bite, say when to come back, and ignore the address a client claims
    c = Check("B", "rate limits answer 429 with retry-after, whatever address a client claims")
    saw_429 = retry = False
    # comments allow 30 per account in 10 minutes (the participant has posted one above), and the bucket gains one
    # back every 20 seconds while this loop runs: a slow client (Python on Windows can take 2 s a request to
    # localhost) earns several more, so the loop leaves room for them
    for i in range(1, 81):
        s, body, headers = participant.request(
            "POST", comments_url, {"body": f"isolation check: filler comment {i}"})
        if s == 429:
            saw_429 = True
            retry = bool(headers.get("retry-after"))
            break
    expect(c, saw_429, participant, "POST", comments_url, f"still not limited after {i} attempts",
           "a 429 within 80 attempts")
    if saw_429:
        expect(c, retry, participant, "POST", comments_url, "429 without a retry-after header",
               "a retry-after header")
    saw_429 = False
    if code:
        enter_url = u(f"/api/vote/{code}")
        # each attempt names a new X-Forwarded-For address: the limit must hold anyway
        for i in range(1, 13):
            s, body, _ = anon.request("POST", enter_url, headers={"X-Forwarded-For": f"198.51.100.{i}"})
            if s == 429:
                saw_429 = True
                break
        expect(c, saw_429, anon, "POST", enter_url, f"still not limited after {i} attempts, each from a claimed new address",
               "a 429 within 12 attempts")
    else:
        expect(c, False, anon, "POST", u("/api/vote/<code>"), "no open-link code from B4 to probe",
               "a 429 within 12 attempts")
    checks.append(c)

    # B10 -- close the window: the tally appears, the voided pick does not count, and the
    # open link's ballot shows apart without adding to the count
    c = Check("B", "closed tally counts every ballot but the voided one, the open link's apart")
    closing = {"votingOpenAt": open_past, "votingCloseAt": close_past,
               "modes": ["account", "listed", "link"], "votesPerVoter": 3}
    s, _, _ = organizer.request("PUT", settings_url, closing)
    expect(c, s == 200, organizer, "PUT", settings_url, s, "200")
    s, body, _ = visitor.request("GET", community_url)
    if expect(c, s == 200, visitor, "GET", community_url, s, "200"):
        data = as_json(body)
        expect(c, data.get("state") == "closed", visitor, "GET", community_url,
               f"state {data.get('state')!r}", "state 'closed'")
        tally = data.get("tally")
        if expect(c, isinstance(tally, list) and len(tally) > 0, visitor, "GET", community_url,
                  f"tally {tally!r}", "a non-empty list"):
            votes = {t.get("projectId"): t.get("votes") for t in tally}
            expect(c, votes.get("prj_03") == 0, visitor, "GET", community_url,
                   f"prj_03 has {votes.get('prj_03')} votes (only the voided voter picked it)",
                   "prj_03 with 0 votes")
            expect(c, votes.get("prj_02") == 1, visitor, "GET", community_url,
                   f"prj_02 has {votes.get('prj_02')} votes (the participant picked it)",
                   "prj_02 with 1 vote, as a positive control")
            link = {t.get("projectId"): t.get("openLink") for t in tally}
            expect(c, (votes.get("prj_04"), link.get("prj_04"), link.get("prj_03")) == (0, 1, 0), visitor, "GET", community_url,
                   f"prj_04 votes {votes.get('prj_04')}, open link {link.get('prj_04')}; prj_03 open link {link.get('prj_03')}",
                   "prj_04: 0 votes and 1 from the open link; prj_03: 0 from the open link (voided)")
            expect(c, data.get("countLink") is False, visitor, "GET", community_url,
                   f"countLink {data.get('countLink')!r}", "countLink false, as the event left it")
    checks.append(c)

    # B11 -- results stay hidden until the organizers publish them
    c = Check("B", "results page hides unpublished scores")
    event_url = u(f"/api/events/{EVENT_ID}/export/event.json")
    s, body, _ = organizer.request("GET", event_url)
    published = None
    if expect(c, s == 200, organizer, "GET", event_url, s, "200"):
        published = as_json(body).get("event", {}).get("resultsPublishedAt")
    if published:
        c.skipped = True
        c.note(f"skipped: results were already published ({published}); nothing to hide-check")
    else:
        results_url = u(f"/events/{EVENT_SLUG}/results")
        s, body, _ = visitor.request("GET", results_url)
        if expect(c, s == 200, visitor, "GET", results_url, s, "200"):
            expect(c, "Not yet published" in body, visitor, "GET", results_url,
                   "the page does not say 'Not yet published'", "the text 'Not yet published'")
    checks.append(c)

    # B12 -- the anti-abuse audit trail: every step above left its row
    c = Check("B", "voting and comment steps are in the audit log")
    audit_url = u(f"/api/events/{EVENT_ID}/export/audit.csv")
    s, body, _ = organizer.request("GET", audit_url)
    if expect(c, s == 200, organizer, "GET", audit_url, s, "200"):
        rows = list(csv.DictReader(io.StringIO(body)))
        seen = {}
        for r in rows:
            seen.setdefault(r.get("action", ""), []).append(r.get("target_id", ""))
        wanted = {
            "voting.settings": 2, "voting.link": 1, "voter.join_link": 2, "voting.voters_added": 1,
            "vote.cast": 4, "voter.void": 1, "comment.post": 2, "comment.hide": 1,
            "comment.unhide": 1, "comment.deleted": 1,
        }
        for action, n in wanted.items():
            got = len(seen.get(action, []))
            expect(c, got >= n, organizer, "GET", audit_url, f"{got} {action} rows", f"at least {n}")
        expect(c, link_a_id in seen.get("voter.void", []), organizer, "GET", audit_url,
               f"voter.void targets {seen.get('voter.void', [])!r}", f"a voter.void row for {link_a_id!r}")
        limited = seen.get("ratelimit.refused", [])
        for what in ("comment", "open-link entry"):
            expect(c, what in limited, organizer, "GET", audit_url,
                   f"ratelimit.refused targets {limited!r}", f"a refusal row for {what!r}")
    checks.append(c)

    # ============ Section C: T4 (tests/isolation_t4.py; it publishes the results) ============
    from isolation_t4 import section_c

    people = {"visitor": visitor, "participant": participant, "judge_a": judge_a, "judge_b": judge_b, "organizer": organizer}
    checks += section_c(u, people, cfg)

    return checks


def main():
    ap = argparse.ArgumentParser(description="DOGFOOD 2026 isolation hand-check")
    ap.add_argument("config", nargs="?", default=".dogfood.toml",
                    help="path to .dogfood.toml (default: ./.dogfood.toml)")
    args = ap.parse_args()

    with open(args.config, "rb") as f:
        cfg = tomllib.load(f)
    base = cfg["portal"]["base_url"]

    print("DOGFOOD 2026 isolation hand-check")
    print(f"portal: {base}")
    print("warning: this check writes data (votes, comments, voting settings) and publishes")
    print("the sample event's results; run it on a fresh instance, after run.py, never on one you care about.")
    print()

    checks = run_checks(cfg)

    width = max(len(c.label) for c in checks) + 2
    for c in checks:
        dots = "." * (width - len(c.label))
        verdict = "SKIP" if c.skipped else ("PASS" if c.ok else "FAIL")
        print(f"{c.section}  {c.label} {dots} {verdict}")
        for line in c.detail:
            print(f"       {line}")

    ran = [c for c in checks if not c.skipped]
    passed = sum(1 for c in ran if c.ok)
    print()
    print(f"isolation: {passed} of {len(ran)} checks passed")

    b_ran = [c for c in checks if c.section == "B" and not c.skipped]
    verified = all(c.ok for c in b_ran)
    print(f"T3 behaviour: {'verified' if verified else 'NOT verified'}")
    c_all = [c for c in checks if c.section == "C"]
    c_ran = [c for c in c_all if not c.skipped]
    skipped = len(c_all) - len(c_ran)
    note = f" ({skipped} skipped, see above)" if skipped else ""
    print(f"T4 behaviour: {'verified' if c_ran and all(c.ok for c in c_ran) else 'NOT verified'}{note}")

    return 0 if passed == len(ran) else 1


if __name__ == "__main__":
    sys.exit(main())
