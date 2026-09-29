#!/usr/bin/env python3
"""DOGFOOD 2026 isolation hand-check, Section C: the T4 features.

Runs after Sections A and B of isolation_check.py on the same instance (the
driver wires them together), so voting is closed, the comment Section B hid has
been unhidden and deleted again, and the results are not yet published when it starts. It then publishes the sample
event, so the instance is spent for A and B afterwards.

Covers, as numbered checks: the OpenAPI document and bearer auth (a session
token and a real API token, revoked), a settings round trip read back, webhooks
(private targets refused, a change queued with its audit hash; C10 a failed
delivery retried with backoff), signed records end to end (publish, issue,
verify, tamper), the awards on every certificate (C11), the offline verifier
script, the embed widget and which pages may be framed, bulk import and export
(a file bringing a new criterion to a scored event, and one that would add
to a published event, refused), personal claim links and
their refusal for someone another organizer's event holds (C12), and pairwise
judging with a "too close to call" answer (C9, run before C4 because publishing
makes the judging mode final). The signed webhook request itself is checked by
tests/webhook_live_check.py, on a portal that may send to a local receiver.
Standard library only.
"""

import csv
import html
import io
import json
import secrets
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from isolation_check import Check, Person, as_json, error_code, expect

EVENT_ID = "evt_01"
EVENT_SLUG = "sample-hack-2026"
VERIFY_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "verify-record.mjs"


def section_c(u, people, cfg):
    visitor = people["visitor"]
    participant = people["participant"]
    judge_a = people["judge_a"]
    judge_b = people["judge_b"]
    organizer = people["organizer"]
    auth = cfg.get("auth", {})

    def bearer(key, name):
        """A Person that authenticates with Authorization: Bearer <token>."""
        token = auth.get(key, "").partition("session=")[2]
        return Person(name, f"Authorization: Bearer {token}" if token else None)

    organizer_bearer = bearer("organizer", "the organizer by bearer token")
    participant_bearer = bearer("participant", "the participant by bearer token")

    checks = []
    judge_envelope = {}  # filled by C4, read again by C5
    tampered_envelope = {}
    keys_text = None

    # C1 -- the OpenAPI document, the readable docs page, and bearer auth
    c = Check("C1", "REST API: OpenAPI document and bearer auth")
    doc_url = u("/api/openapi.json")
    s, body, _ = visitor.request("GET", doc_url)
    if expect(c, s == 200, visitor, "GET", doc_url, s, "200"):
        doc = as_json(body)
        expect(c, doc.get("openapi") == "3.1.0", visitor, "GET", doc_url,
               f"openapi {doc.get('openapi')!r}", "openapi '3.1.0'")
        paths = doc.get("paths", {})
        methods = ("get", "post", "put", "delete")
        ops = sum(1 for p in paths.values() if isinstance(p, dict) for m in p if m in methods)
        expect(c, ops >= 60, visitor, "GET", doc_url, f"{ops} operations", "at least 60")
        for path in ("/api/events/{event}/overview", "/api/events/{event}/prizes",
                     "/api/events/{event}/webhooks", "/api/events/{event}/webhooks/{webhook}/deliveries",
                     "/api/events/{event}/publish", "/api/events/{event}/records",
                     "/api/events/{event}/records/all", "/api/records/{record}", "/api/records/verify",
                     "/.well-known/dogfood-keys.json", "/api/imports", "/api/claims/{token}",
                     "/api/projects/{project}/comments"):
            expect(c, path in paths, visitor, "GET", doc_url, f"no {path}", f"{path} documented")
    docs_url = u("/api-docs")
    s, _, _ = visitor.request("GET", docs_url)
    expect(c, s == 200, visitor, "GET", docs_url, s, "200")
    overview_url = u(f"/api/events/{EVENT_ID}/overview")
    s, _, _ = organizer_bearer.request("GET", overview_url)
    expect(c, s == 200, organizer_bearer, "GET", overview_url, s, "200 with the organizer's bearer token")
    s, _, _ = participant_bearer.request("GET", overview_url)
    expect(c, s == 403, participant_bearer, "GET", overview_url, s, "403 with the participant's bearer token")
    s, _, _ = visitor.request("GET", overview_url)
    expect(c, s == 401, visitor, "GET", overview_url, s, "401 with no auth")
    # a real API token, made the way /account/tokens makes one: it acts with its owner's permissions, cannot make
    # more tokens, and stops working the moment it is revoked
    tokens_url = u("/api/tokens")
    made = {}
    for person, key in ((organizer, "organizer"), (participant, "participant")):
        s, body, _ = person.request("POST", tokens_url, {"name": f"isolation check {secrets.token_hex(2)}", "days": 1})
        if expect(c, s == 201, person, "POST", tokens_url, f"{s} ({error_code(body)})", "201"):
            data = as_json(body)
            expect(c, str(data.get("token", "")).startswith("dfk_") and bool(data.get("id")), person, "POST", tokens_url,
                   f"token {str(data.get('token'))[:6]!r}, id {data.get('id')!r}", "a dfk_ token and its id")
            made[key] = (data.get("id"), Person(f"{person.name} by API token", f"Authorization: Bearer {data.get('token')}"))
    s, _, _ = visitor.request("POST", tokens_url, {"name": "no session", "days": 1})
    expect(c, s == 401, visitor, "POST", tokens_url, s, "401 with no auth")
    if "organizer" in made and "participant" in made:
        org_id, org_token = made["organizer"]
        _, part_token = made["participant"]
        s, _, _ = org_token.request("GET", overview_url)
        expect(c, s == 200, org_token, "GET", overview_url, s, "200 with the organizer's API token")
        s, _, _ = part_token.request("GET", overview_url)
        expect(c, s == 403, part_token, "GET", overview_url, s, "403 with the participant's API token")
        s, body, _ = org_token.request("POST", tokens_url, {"name": "made by a token", "days": 1})
        expect(c, s == 403 and error_code(body) == "token_cannot_manage_tokens", org_token, "POST", tokens_url,
               f"{s} {error_code(body)}", "403 token_cannot_manage_tokens")
        # nor anything that ends in a full sign-in: a password reset link, personal claim links
        resets_url = u("/api/password-resets")
        s, body, _ = org_token.request("POST", resets_url, {"email": "nobody@example.org"})
        expect(c, s == 403 and error_code(body) == "token_cannot_reset_passwords", org_token, "POST", resets_url,
               f"{s} {error_code(body)}", "403 token_cannot_reset_passwords")
        claims_url = u(f"/api/events/{EVENT_ID}/claims")
        s, body, _ = org_token.request("POST", claims_url, {})
        expect(c, s == 403 and error_code(body) == "token_cannot_issue_claims", org_token, "POST", claims_url,
               f"{s} {error_code(body)}", "403 token_cannot_issue_claims")
        revoke_url = u(f"/api/tokens/{org_id}/revoke")
        s, _, _ = participant.request("POST", revoke_url)
        expect(c, s == 404, participant, "POST", revoke_url, s, "404: someone else's token is not theirs to revoke")
        s, _, _ = org_token.request("GET", overview_url)
        expect(c, s == 200, org_token, "GET", overview_url, s, "200: still working after the refused revoke")
        s, _, _ = organizer.request("POST", revoke_url)
        expect(c, s == 200, organizer, "POST", revoke_url, s, "200")
        s, _, _ = org_token.request("GET", overview_url)
        expect(c, s == 401, org_token, "GET", overview_url, s, "401 once revoked")
    made_up = Person("a made-up API token", f"Authorization: Bearer dfk_{secrets.token_hex(20)}")
    s, _, _ = made_up.request("GET", overview_url)
    expect(c, s == 401, made_up, "GET", overview_url, s, "401 for a token the portal never made")
    checks.append(c)

    # C2 -- a settings round trip: read the prizes from event.json, PUT them back
    c = Check("C2", "REST API: settings round trip")
    event_json_url = u(f"/api/events/{EVENT_ID}/export/event.json")
    rows = []
    s, body, _ = organizer.request("GET", event_json_url)
    if expect(c, s == 200, organizer, "GET", event_json_url, s, "200"):
        rows = [{"id": p.get("id", ""), "name": p.get("name", ""), "description": p.get("description") or ""}
                for p in as_json(body).get("prizes", [])]
    prizes_url = u(f"/api/events/{EVENT_ID}/prizes")
    s, _, _ = organizer.request("PUT", prizes_url, rows)
    expect(c, s == 200, organizer, "PUT", prizes_url, s, f"200 putting the {len(rows)} exported rows back")
    s, _, _ = participant.request("PUT", prizes_url, rows)
    expect(c, s == 403, participant, "PUT", prizes_url, s, "403")

    def prizes_now():
        s, body, _ = organizer.request("GET", event_json_url)
        if not expect(c, s == 200, organizer, "GET", event_json_url, s, "200"):
            return None
        return [(p.get("name"), p.get("description") or "") for p in as_json(body).get("prizes", [])]

    # the round trip proper: change something, read it back, put the original back, read that back too
    extra = {"id": "", "name": f"Isolation prize {secrets.token_hex(3)}", "description": "added by the isolation check"}
    changed = [dict(r, description=(r["description"] + " (edited)").strip()) for r in rows] + [extra]
    s, _, _ = organizer.request("PUT", prizes_url, changed)
    if expect(c, s == 200, organizer, "PUT", prizes_url, s, f"200 for {len(changed)} changed rows"):
        got = prizes_now()
        expect(c, got == [(r["name"], r["description"]) for r in changed], organizer, "GET", event_json_url,
               f"prizes {got!r}", "the prizes as just saved, in order")
    s, _, _ = participant.request("PUT", prizes_url, [])
    expect(c, s == 403, participant, "PUT", prizes_url, s, "403 for a participant emptying the list")
    s, _, _ = organizer.request("PUT", prizes_url, rows)
    if expect(c, s == 200, organizer, "PUT", prizes_url, s, "200 putting the original rows back"):
        got = prizes_now()
        expect(c, got == [(r["name"], r["description"]) for r in rows], organizer, "GET", event_json_url,
               f"prizes {got!r}", "the original prizes again (the participant's refused save changed nothing)")
    # what teams fill in: public to read; put back unchanged by the organizer only
    fields_url = u(f"/api/events/{EVENT_ID}/project-fields")
    fields = {}
    s, body, _ = visitor.request("GET", fields_url)
    if expect(c, s == 200, visitor, "GET", fields_url, s, "200"):
        fields = as_json(body).get("fields", {})
        expect(c, fields.get("trackId") in ("required", "hidden"), visitor, "GET", fields_url,
               f"trackId {fields.get('trackId')!r}", "a track that is required or hidden")
    s, _, _ = organizer.request("PUT", fields_url, fields)
    expect(c, s == 200, organizer, "PUT", fields_url, s, f"200 putting the {len(fields)} fields back")
    s, _, _ = participant.request("PUT", fields_url, fields)
    expect(c, s == 403, participant, "PUT", fields_url, s, "403")
    s, _, _ = visitor.request("PUT", fields_url, fields)
    expect(c, s == 401, visitor, "PUT", fields_url, s, "401")
    # one field changed, read back by anyone, then put back
    field = next((f for f in ("summary", "repoUrl", "demoUrl") if f in fields), None)
    if expect(c, field is not None, visitor, "GET", fields_url, f"fields {sorted(fields)}", "a summary, repoUrl or demoUrl field"):
        was = fields[field]
        to = "optional" if was != "optional" else "required"
        s, body, _ = organizer.request("PUT", fields_url, {field: to})
        if expect(c, s == 200, organizer, "PUT", fields_url, f"{s} ({error_code(body)})", f"200 making {field} {to}"):
            s, body, _ = visitor.request("GET", fields_url)
            now = as_json(body).get("fields", {})
            expect(c, now == dict(fields, **{field: to}), visitor, "GET", fields_url,
                   f"fields {now!r}", f"the fields as before with {field} {to}")
        s, _, _ = organizer.request("PUT", fields_url, {field: was})
        if expect(c, s == 200, organizer, "PUT", fields_url, s, f"200 putting {field} back to {was}"):
            s, body, _ = visitor.request("GET", fields_url)
            now = as_json(body).get("fields", {})
            expect(c, now == fields, visitor, "GET", fields_url, f"fields {now!r}", "the fields as they were")
    checks.append(c)

    # C3 -- webhooks: private target refused, a change queued in the same transaction
    c = Check("C3", "webhooks: private targets refused, a change queued with its audit hash")
    hooks_url = u(f"/api/events/{EVENT_ID}/webhooks")
    s, body, _ = organizer.request("POST", hooks_url, {"url": "http://127.0.0.1:9/hook", "actions": ["*"]})
    expect(c, s == 422, organizer, "POST", hooks_url, f"{s} ({error_code(body)})", "422 for a private target")
    # a public target whose name resolves; hooks.example.org has no DNS record and would 422
    public_body = {"url": "https://example.org/dogfood", "actions": ["comment.post"]}
    s, body, _ = organizer.request("POST", hooks_url, public_body)
    hook_id = secret = None
    if expect(c, s == 201, organizer, "POST", hooks_url, f"{s} ({error_code(body)})", "201 for a public target"):
        data = as_json(body)
        hook_id = data.get("id")
        secret = data.get("secret", "")
        expect(c, bool(hook_id), organizer, "POST", hooks_url, f"no id in the body ({body[:120]!r})", "an id")
        expect(c, secret.startswith("whsec_"), organizer, "POST", hooks_url,
               f"secret {secret[:12]!r}", "a secret starting 'whsec_'")
    s, _, _ = participant.request("POST", hooks_url, public_body)
    expect(c, s == 403, participant, "POST", hooks_url, s, "403")
    # judge_a comments: the participant's comment limit was used up on purpose in Section B
    comment_id = None
    comments_url = u("/api/projects/prj_03/comments")
    s, body, _ = judge_a.request("POST", comments_url, {"body": "isolation check: a comment for the webhook"})
    if expect(c, s == 201, judge_a, "POST", comments_url, s, "201"):
        comment_id = as_json(body).get("id")
        expect(c, bool(comment_id), judge_a, "POST", comments_url,
               f"no id in the body ({body[:120]!r})", "an id")
    if hook_id:
        one = u(f"/api/events/{EVENT_ID}/webhooks/{hook_id}")
        deliveries_url = one + "/deliveries"
        audit_url = u(f"/api/events/{EVENT_ID}/export/audit.csv")
        if comment_id:
            # the delivery carries the audit row itself: its id and its hash
            s, body, _ = organizer.request("GET", deliveries_url)
            delivery = None
            if expect(c, s == 200, organizer, "GET", deliveries_url, s, "200"):
                delivery = next(
                    (d for d in as_json(body).get("deliveries", [])
                     if d.get("action") == "comment.post"
                     and ((d.get("payload", {}).get("data", {}).get("after") or {}).get("comment") == comment_id)),
                    None)
            if expect(c, delivery is not None, organizer, "GET", deliveries_url,
                      "no comment.post delivery for the new comment", "the queued delivery"):
                data = (delivery.get("payload") or {}).get("data") or {}
                hook_hash = data.get("hash")
                s, body, _ = organizer.request("GET", audit_url)
                if expect(c, s == 200, organizer, "GET", audit_url, s, "200"):
                    rows = list(csv.DictReader(io.StringIO(body)))
                    row = next((r for r in rows if r.get("action") == "comment.post"
                                and r.get("id") == str(data.get("auditId"))), None)
                    if expect(c, row is not None, organizer, "GET", audit_url,
                              f"no comment.post audit row with id {data.get('auditId')!r}", "the matching row"):
                        expect(c, bool(hook_hash) and hook_hash == row.get("hash"), organizer,
                               "GET", deliveries_url, f"payload hash {hook_hash!r}",
                               f"the audit row's hash {row.get('hash')!r}")
        test_url = one + "/test"
        s, _, _ = organizer.request("POST", test_url)
        if expect(c, s == 200, organizer, "POST", test_url, s, "200"):
            s, body, _ = organizer.request("GET", deliveries_url)
            saw = s == 200 and any(d.get("action") == "webhook.test" for d in as_json(body).get("deliveries", []))
            expect(c, saw, organizer, "GET", deliveries_url, "no webhook.test delivery", "a webhook.test delivery")
        rotate_url = one + "/rotate-secret"
        s, body, _ = organizer.request("POST", rotate_url)
        if expect(c, s == 200, organizer, "POST", rotate_url, s, "200"):
            new_secret = as_json(body).get("secret", "")
            expect(c, new_secret.startswith("whsec_") and new_secret != secret, organizer,
                   "POST", rotate_url, f"secret {new_secret[:12]!r}",
                   "a different secret, still starting 'whsec_'")
        for what in ("disable", "enable"):
            s, _, _ = organizer.request("POST", one + "/" + what)
            expect(c, s == 200, organizer, "POST", one + "/" + what, s, "200")
    checks.append(c)

    # C10 -- a delivery that fails is tried again, 10 s and then 60 s later (RETRY_DELAYS_S in src/server/webhooks.ts).
    # The target is under .invalid, a name that never resolves (RFC 6761): accepted when added, since an offline
    # portal cannot tell, and refused at every send, so this works the same with the network on or off. The signed
    # request itself needs a receiver the portal may reach: tests/webhook_live_check.py, on a portal started with
    # WEBHOOKS_ALLOW_PRIVATE=true (that setting would make C3's private-target refusal wrong here).
    c = Check("C10", "webhooks: a failed delivery is retried with backoff, 10 s then 60 s")
    s, body, _ = organizer.request("POST", hooks_url, {"url": f"https://hook-{secrets.token_hex(3)}.invalid/dogfood", "actions": ["comment.post"]})
    retry_hook = as_json(body).get("id") if s == 201 else None
    expect(c, bool(retry_hook), organizer, "POST", hooks_url, f"{s} ({error_code(body)})", "201 for a name that does not resolve yet")
    if retry_hook:
        one = u(f"/api/events/{EVENT_ID}/webhooks/{retry_hook}")
        s, _, _ = organizer.request("POST", one + "/test")
        expect(c, s == 200, organizer, "POST", one + "/test", s, "200")

        def attempts_reach(n, within):
            """Poll the delivery log until the test delivery has n attempts; return it, or None after `within` s."""
            end = time.monotonic() + within
            while True:
                s, body, _ = organizer.request("GET", one + "/deliveries")
                d = next((x for x in as_json(body).get("deliveries", []) if x.get("action") == "webhook.test"), None) if s == 200 else None
                if d and d.get("attempts", 0) >= n:
                    return d
                if time.monotonic() > end:
                    return d
                time.sleep(0.5)

        def gap(d):
            try:
                last = datetime.fromisoformat(d["lastAttemptAt"].replace("Z", "+00:00"))
                nxt = datetime.fromisoformat(d["nextAttemptAt"].replace("Z", "+00:00"))
                return round((nxt - last).total_seconds())
            except (KeyError, TypeError, AttributeError, ValueError):
                return None

        first = attempts_reach(1, 30)
        if expect(c, bool(first) and first.get("attempts") == 1, organizer, "GET", one + "/deliveries",
                  f"delivery {first!r}"[:200], "one attempt within 30 s (the worker runs every 2 s)"):
            expect(c, first.get("status") == "pending" and "not sent" in str(first.get("error")), organizer, "GET",
                   one + "/deliveries", f"status {first.get('status')!r}, error {first.get('error')!r}",
                   "still pending, with why it was not sent")
            expect(c, gap(first) == 10, organizer, "GET", one + "/deliveries",
                   f"next attempt {gap(first)!r} s after the first", "10 s after the first")
            second = attempts_reach(2, 30)
            if expect(c, bool(second) and second.get("attempts") == 2, organizer, "GET", one + "/deliveries",
                      f"delivery {second!r}"[:200], "a second attempt about 10 s later"):
                expect(c, second.get("status") == "pending" and gap(second) == 60, organizer, "GET", one + "/deliveries",
                       f"status {second.get('status')!r}, next attempt {gap(second)!r} s after the second", "pending, 60 s after the second")
                expect(c, second.get("id") == first.get("id"), organizer, "GET", one + "/deliveries",
                       f"delivery {second.get('id')!r} after {first.get('id')!r}", "the same delivery tried again, not a new one")
        s, _, _ = organizer.request("POST", one + "/disable")
        expect(c, s == 200, organizer, "POST", one + "/disable", s, "200 turning the test webhook off")
    checks.append(c)

    # C9 -- pairwise judging (JUDGING.md "Pairwise mode"). It runs here, before C4, because
    # publishing makes the judging mode final; it puts the event back in scores mode after.
    c = Check("C9", "pairwise judging: only judges answer, only the question asked, peers isolated, only organizers rank")
    mode_url = u(f"/api/events/{EVENT_ID}/judging-mode")
    state_url = u(f"/api/judge/{EVENT_ID}/pairwise")
    pick_url = u(f"/api/judge/{EVENT_ID}/pairwise/pick")
    undo_url = u(f"/api/judge/{EVENT_ID}/pairwise/undo")
    ranking_url = u(f"/api/events/{EVENT_ID}/pairwise")
    to_pairwise = {"mode": "pairwise", "reason": "isolation check C9"}
    s, body, _ = judge_a.request("POST", pick_url, {"trackId": "x", "left": "a", "right": "b", "outcome": "left"})
    expect(c, s == 409 and error_code(body) == "not_pairwise", judge_a, "POST", pick_url, f"{s} {error_code(body)}", "409 not_pairwise in scores mode")
    for person in (participant, judge_a):
        s, _, _ = person.request("PUT", mode_url, to_pairwise)
        expect(c, s == 403, person, "PUT", mode_url, s, "403: only an organizer switches the mode")
    s, _, _ = organizer.request("PUT", mode_url, to_pairwise)
    switched = expect(c, s == 200, organizer, "PUT", mode_url, s, "200")
    question = None
    if switched:
        s, body, _ = judge_a.request("GET", state_url)
        if expect(c, s == 200, judge_a, "GET", state_url, s, "200"):
            track = next((t for t in as_json(body).get("tracks", []) if t.get("current")), None)
            if expect(c, track is not None, judge_a, "GET", state_url, "no question", "a question in some track"):
                q = track["current"]
                question = {"trackId": track["trackId"], "left": q["left"]["id"], "right": q["right"]["id"]}
    if question:
        swapped = {**question, "left": question["right"], "right": question["left"], "outcome": "left"}
        s, body, _ = judge_a.request("POST", pick_url, swapped)
        expect(c, s == 409 and error_code(body) == "question_changed", judge_a, "POST", pick_url,
               f"{s} {error_code(body)}", "409 question_changed for the sides swapped")
        s, _, _ = judge_a.request("POST", pick_url, {**question, "outcome": "left"})
        expect(c, s == 200, judge_a, "POST", pick_url, s, "200 for the question asked")
        s, _, _ = organizer.request("POST", pick_url, {**question, "outcome": "left"})
        expect(c, s == 403, organizer, "POST", pick_url, s, "403: the organizer is not a judge here")
        s, body, _ = judge_b.request("GET", state_url)
        if expect(c, s == 200, judge_b, "GET", state_url, s, "200"):
            answered = sum(t.get("answered", 0) for t in as_json(body).get("tracks", []))
            expect(c, answered == 0, judge_b, "GET", state_url, f"{answered} answers", "0: judge_a's answer never shows")
        s, _, _ = participant.request("GET", state_url)
        expect(c, s == 403, participant, "GET", state_url, s, "403")
        s, _, _ = judge_a.request("GET", ranking_url)
        expect(c, s == 403, judge_a, "GET", ranking_url, s, "403: only organizers read the ranking")
        s, body, _ = organizer.request("GET", ranking_url)
        if expect(c, s == 200, organizer, "GET", ranking_url, s, "200"):
            picks = as_json(body).get("counts", {}).get("picks")
            expect(c, picks == 1, organizer, "GET", ranking_url, f"{picks} answers", "1 answer in the fit")
        s, _, _ = judge_a.request("POST", undo_url, {"trackId": question["trackId"]})
        expect(c, s == 200, judge_a, "POST", undo_url, s, "200: the answer is taken back")
        # the same question again, answered "too close to call": the new project goes right below the other one,
        # and the ranking counts it as a tie (half a win each way), not as a win for either side
        s, body, _ = judge_a.request("GET", state_url)
        track = next((t for t in as_json(body).get("tracks", []) if t.get("trackId") == question["trackId"]), {})
        cur = track.get("current") or {}
        expect(c, (cur.get("left") or {}).get("id") == question["left"] and (cur.get("right") or {}).get("id") == question["right"],
               judge_a, "GET", state_url, f"current {str(cur)[:120]}", "the question back after the undo")
        new_id = cur.get("newId")
        other = question["right"] if new_id == question["left"] else question["left"]
        s, body, _ = judge_a.request("POST", pick_url, {**question, "outcome": "tie"})
        if expect(c, s == 200, judge_a, "POST", pick_url, f"{s} {error_code(body)}", "200 for too close to call"):
            s, body, _ = judge_a.request("GET", state_url)
            track = next((t for t in as_json(body).get("tracks", []) if t.get("trackId") == question["trackId"]), {})
            order = [p.get("id") for p in track.get("list", [])]
            placed = new_id in order and other in order and order.index(new_id) == order.index(other) + 1
            expect(c, placed, judge_a, "GET", state_url, f"list {order!r} (new {new_id}, other {other})",
                   "the new project right below the one it tied with")
            s, body, _ = organizer.request("GET", ranking_url)
            if expect(c, s == 200, organizer, "GET", ranking_url, s, "200"):
                rows = [r for t in as_json(body).get("tracks", []) for r in t.get("rows", [])]
                row = next((r for r in rows if r.get("projectId") == new_id), {})
                lines = [x for x in row.get("receipt", []) if x.get("kind") == "pick" and x.get("opponentId") == other]
                expect(c, [x.get("result") for x in lines] == ["tie"], organizer, "GET", ranking_url,
                       f"receipt lines {lines!r}"[:200], f"one 'tie' against {other} on {new_id}'s receipt")
            s, _, _ = judge_a.request("POST", undo_url, {"trackId": question["trackId"]})
            expect(c, s == 200, judge_a, "POST", undo_url, s, "200: the tie is taken back too")
        s, body, _ = judge_a.request("POST", undo_url, {"trackId": question["trackId"]})
        expect(c, s == 409 and error_code(body) == "nothing_to_undo", judge_a, "POST", undo_url,
               f"{s} {error_code(body)}", "409 nothing_to_undo")
    if switched:
        s, _, _ = organizer.request("PUT", mode_url, {"mode": "scores", "reason": "isolation check C9 done"})
        expect(c, s == 200, organizer, "PUT", mode_url, s, "200 back to scores for C4")
    checks.append(c)

    # C4 -- records: settle the three decisions, publish, issue, verify, tamper
    c = Check("C4", "records: publish, issue, verify, tamper")
    s, _, _ = organizer.request("POST", u(f"/api/events/{EVENT_ID}/judges/jdg_07/override"),
                                {"mode": "exclude", "reason": "flat vector, isolation check"})
    expect(c, s == 200, organizer, "POST", u(f"/api/events/{EVENT_ID}/judges/jdg_07/override"), s, "200")
    merge_url = u(f"/api/events/{EVENT_ID}/duplicates/merge")
    s, _, _ = organizer.request("POST", merge_url, {"keepId": "prj_07", "duplicateId": "prj_41"})
    expect(c, s == 200, organizer, "POST", merge_url, s, "200")
    accept_url = u(f"/api/events/{EVENT_ID}/projects/prj_19/accept-under-reviewed")
    s, body, _ = organizer.request("POST", accept_url, {"reason": "one review, isolation check"})
    if s == 409:
        c.note(f"POST {accept_url}")
        c.note("sent as the organizer")
        c.note(f"409 ({error_code(body)}): prj_19 was accepted before this run; taken as done")
    else:
        expect(c, s == 200, organizer, "POST", accept_url, s, "200")
    publish_url = u(f"/api/events/{EVENT_ID}/publish")
    s, body, _ = organizer.request("POST", publish_url)
    expect(c, s == 200, organizer, "POST", publish_url, f"{s} ({error_code(body)})", "200 once every decision is made")
    issue_all_url = u(f"/api/events/{EVENT_ID}/records/all")
    s, _, _ = participant.request("POST", issue_all_url)
    expect(c, s == 403, participant, "POST", issue_all_url, s, "403")
    s, body, _ = organizer.request("POST", issue_all_url)
    if expect(c, s == 200, organizer, "POST", issue_all_url, s, "200"):
        data = as_json(body)
        expect(c, data.get("judges", 0) > 0, organizer, "POST", issue_all_url,
               f"judges {data.get('judges')!r}", "at least one judge record")
        expect(c, data.get("participants", 0) > 0, organizer, "POST", issue_all_url,
               f"participants {data.get('participants')!r}", "at least one certificate")
    mine_url = u(f"/api/events/{EVENT_ID}/records")
    s, body, _ = judge_a.request("POST", mine_url, {"kind": "judge"})
    record_id = None
    if expect(c, s in (200, 201), judge_a, "POST", mine_url, s, "200 or 201"):
        record_id = as_json(body).get("id")
        expect(c, bool(record_id), judge_a, "POST", mine_url, f"no id in the body ({body[:120]!r})", "an id")
    s, _, _ = participant.request("POST", mine_url, {"kind": "judge"})
    expect(c, s == 403, participant, "POST", mine_url, s, "403 asking for a judge's record")
    judge_name = ""
    if record_id:
        record_url = u(f"/api/records/{record_id}")
        s, body, _ = visitor.request("GET", record_url)
        if expect(c, s == 200, visitor, "GET", record_url, s, "200"):
            data = as_json(body)
            judge_envelope = data.get("envelope", {})
            expect(c, (data.get("verification") or {}).get("valid") is True, visitor, "GET", record_url,
                   f"verification {data.get('verification')!r}", "valid true")
            expect(c, (judge_envelope.get("record") or {}).get("kind") == "judge", visitor, "GET", record_url,
                   f"kind {(judge_envelope.get('record') or {}).get('kind')!r}", "kind 'judge'")
            judge_name = ((judge_envelope.get("record") or {}).get("person") or {}).get("name", "")
        verify_url = u("/api/records/verify")
        s, body, _ = visitor.request("POST", verify_url, judge_envelope)
        if expect(c, s == 200, visitor, "POST", verify_url, s, "200"):
            expect(c, as_json(body).get("valid") is True, visitor, "POST", verify_url,
                   f"{as_json(body)}", "valid true")
        tampered_envelope = json.loads(json.dumps(judge_envelope))
        tampered_envelope["record"]["person"]["name"] = judge_name + " (tampered)"
        s, body, _ = visitor.request("POST", verify_url, tampered_envelope)
        v = as_json(body)
        expect(c, v.get("valid") is False and v.get("reason") == "bad_signature", visitor,
               "POST", verify_url, f"{v}", "valid false, reason 'bad_signature'")
        keys_url = u("/.well-known/dogfood-keys.json")
        s, body, _ = visitor.request("GET", keys_url)
        if expect(c, s == 200, visitor, "GET", keys_url, s, "200"):
            keys_text = body
            keys = as_json(body).get("keys", [])
            expect(c, len(keys) == 1, visitor, "GET", keys_url, f"{len(keys)} keys", "exactly one key")
            if keys:
                expect(c, keys[0].get("kty") == "OKP", visitor, "GET", keys_url,
                       f"kty {keys[0].get('kty')!r}", "kty 'OKP'")
                expect(c, keys[0].get("crv") == "Ed25519", visitor, "GET", keys_url,
                       f"crv {keys[0].get('crv')!r}", "crv 'Ed25519'")
                expect(c, "d" not in keys[0], visitor, "GET", keys_url,
                       "the private half 'd' is published", "no 'd' field")
        page_url = u(f"/records/{record_id}")
        s, body, _ = visitor.request("GET", page_url)
        if expect(c, s == 200, visitor, "GET", page_url, s, "200"):
            expect(c, bool(judge_name) and judge_name in body, visitor, "GET", page_url,
                   f"the judge's name {judge_name!r} is not on the page", "the judge's name")
    s, body, _ = participant.request("POST", mine_url, {"kind": "participant"})
    participant_record = None
    if expect(c, s in (200, 201), participant, "POST", mine_url, s, "200 or 201"):
        participant_record = as_json(body).get("id")
        expect(c, bool(participant_record), participant, "POST", mine_url,
               f"no id in the body ({body[:120]!r})", "an id")
    if participant_record:
        s, body, _ = visitor.request("GET", u(f"/api/records/{participant_record}"))
        if expect(c, s == 200, visitor, "GET", u(f"/api/records/{participant_record}"), s, "200"):
            rec = (as_json(body).get("envelope") or {}).get("record") or {}
            expect(c, rec.get("kind") == "participant", visitor, "GET", u(f"/api/records/{participant_record}"),
                   f"kind {rec.get('kind')!r}", "kind 'participant'")
            expect(c, bool((rec.get("project") or {}).get("title")), visitor,
                   "GET", u(f"/api/records/{participant_record}"),
                   f"project {rec.get('project')!r}", "a project title")
    checks.append(c)

    # C11 -- every certificate carries exactly the awards the published results and the community vote give its
    # project: a place from 1st to the event's certificatePlaces (3 unless set) in its track, "Joint" when shared, and
    # a community-vote win. Worked out here from the public results and community APIs, and from nothing the
    # certificate says; at least one certificate must carry a place and one the vote, so the check cannot pass empty.
    c = Check("C11", "certificates carry the podium places and the community-vote win, and nothing else")
    expected = {}
    s, body, _ = visitor.request("GET", u(f"/api/events/{EVENT_ID}/results"))
    published = as_json(body) if s == 200 else {}
    expect(c, published.get("published") is True, visitor, "GET", u(f"/api/events/{EVENT_ID}/results"),
           f"{s} published {published.get('published')!r}", "200, published")
    s, body, _ = organizer.request("GET", event_json_url)
    upto = ((as_json(body).get("event") or {}).get("settings") or {}).get("certificatePlaces") or 3
    for t in published.get("tracks", []):
        rows = t.get("rows", [])
        for i, r in enumerate(rows):
            if r.get("score") is None:
                continue
            same = [x for x in rows if x.get("score") is not None and abs(x["score"] - r["score"]) <= 1e-9]
            place = rows.index(same[0]) + 1
            if place <= upto:
                n = place
                word = f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"
                joint = len(same) > 1 or rows.index(same[0]) != i
                expected.setdefault(r["projectId"], []).append(f"{'Joint ' if joint else ''}{word} place, {t.get('name')}")
    s, body, _ = visitor.request("GET", u(f"/api/events/{EVENT_ID}/community"))
    tally = as_json(body).get("tally") or []
    winners = [t.get("projectId") for t in tally if t.get("place") == 1 and (t.get("votes") or 0) > 0]
    expect(c, len(winners) >= 1, visitor, "GET", u(f"/api/events/{EVENT_ID}/community"),
           f"winners {winners!r}", "at least one community-vote winner (Section B voted)")
    for p in winners:
        expected.setdefault(p, []).append("Joint winner of the community vote" if len(winners) > 1 else "Winner of the community vote")
    s, body, _ = organizer.request("GET", mine_url)
    listed_records = [r for r in as_json(body).get("records", []) if r.get("kind") == "participant"] if s == 200 else []
    expect(c, len(listed_records) >= 40, organizer, "GET", mine_url, f"{s}, {len(listed_records)} certificates",
           "200 and a certificate for every member of a submitting team")
    with_place = with_vote = 0
    wrong = []
    first_place = None  # (record id, its first award) of a certificate with a 1st place
    for r in listed_records:
        s, body, _ = visitor.request("GET", u(f"/api/records/{r.get('id')}"))
        rec = ((as_json(body).get("envelope") or {}).get("record") or {}) if s == 200 else {}
        project = rec.get("project") or {}
        got = project.get("awards")
        want = expected.get(project.get("id"), [])
        if got != want:
            wrong.append(f"{r.get('id')} ({project.get('id')}): {got!r}, wanted {want!r}")
        with_place += any("place," in a for a in got or [])
        with_vote += any("community vote" in a for a in got or [])
        if first_place is None and got and "1st place" in got[0]:
            first_place = (r.get("id"), got[0])
    expect(c, not wrong, visitor, "GET", u("/api/records/<id>"), f"{len(wrong)} wrong: " + "; ".join(wrong[:3]),
           "every certificate's awards as the results and the vote give them")
    expect(c, with_place > 0 and with_vote > 0, visitor, "GET", u("/api/records/<id>"),
           f"{with_place} with a place, {with_vote} with the vote", "at least one of each")
    # and the printable page says it
    if expect(c, first_place is not None, visitor, "GET", u("/api/records/<id>"),
              "no certificate with a 1st place", "a 1st-place certificate to open"):
        page_url = u(f"/records/{first_place[0]}")
        s, body, _ = visitor.request("GET", page_url)
        expect(c, s == 200 and first_place[1] in body, visitor, "GET", page_url,
               f"{s}, {first_place[1]!r} not on the page", f"the page saying {first_place[1]!r}")
    checks.append(c)

    # C5 -- the same check offline, with scripts/verify-record.mjs and pinned keys
    c = Check("C5", "records: checked offline with scripts/verify-record.mjs")
    node = shutil.which("node")
    if not node:
        c.skipped = True
        c.note("skipped: node is not on PATH, so the offline verifier cannot run here")
    elif keys_text is None or not judge_envelope:
        c.skipped = True
        c.note("skipped: the publish/issue check above did not produce a record and keys to verify offline")
    else:
        expect(c, VERIFY_SCRIPT.is_file(), organizer, "run", str(VERIFY_SCRIPT),
               "not in the repo", "scripts/verify-record.mjs")
        with tempfile.TemporaryDirectory(prefix="dogfood-verify-") as tmp:
            keys_file = Path(tmp) / "keys.json"
            keys_file.write_text(keys_text, encoding="utf-8")
            good_file = Path(tmp) / "record.json"
            good_file.write_text(json.dumps(judge_envelope), encoding="utf-8")
            bad_file = Path(tmp) / "tampered.json"
            bad_file.write_text(json.dumps(tampered_envelope), encoding="utf-8")
            for label, path, wanted in (("the record", good_file, 0), ("the tampered envelope", bad_file, 1)):
                try:
                    run = subprocess.run([node, str(VERIFY_SCRIPT), str(path), "--keys", str(keys_file)],
                                         capture_output=True, text=True, timeout=120)
                    if expect(c, run.returncode == wanted, organizer,
                              "run", f"node scripts/verify-record.mjs {path.name} --keys keys.json",
                              f"exit {run.returncode} for {label}", f"exit {wanted}"):
                        pass
                    out = (run.stdout + run.stderr).strip()
                    if out and run.returncode != wanted:
                        c.note("output: " + out[-300:])
                except Exception as e:
                    expect(c, False, organizer, "run", f"node scripts/verify-record.mjs {path.name}",
                           f"{type(e).__name__}: {e}", f"exit {wanted} for {label}")
    checks.append(c)

    # C6 -- the embeddable widget: the script, the framed page, the locked pages
    c = Check("C6", "embed: the widget and its frame headers")
    s, body, _ = visitor.request("GET", u("/embed.js"))
    if expect(c, s == 200, visitor, "GET", u("/embed.js"), s, "200"):
        expect(c, "data-event" in body, visitor, "GET", u("/embed.js"),
               "no 'data-event' in the script", "the data-event attribute")
    frame_url = u(f"/embed/{EVENT_SLUG}")
    s, frame, headers = visitor.request("GET", frame_url)
    if expect(c, s == 200, visitor, "GET", frame_url, s, "200"):
        expect(c, "frame-ancestors *" in headers.get("content-security-policy", ""), visitor,
               "GET", frame_url, f"content-security-policy {headers.get('content-security-policy')!r}",
               "frame-ancestors *")
        expect(c, "x-frame-options" not in {k.lower() for k in headers.keys()}, visitor, "GET", frame_url,
               f"x-frame-options {headers.get('x-frame-options')!r}", "no X-Frame-Options on the one framable page")
        # the frame is the gallery: every submitted project, by title, each linking to its page
        s, body, _ = visitor.request("GET", u(f"/api/events/{EVENT_ID}/projects"))
        gallery = as_json(body).get("projects", []) if s == 200 else []
        missing = [p.get("id") for p in gallery if html.escape(p.get("title", ""), quote=False) not in frame]
        unlinked = [p.get("id") for p in gallery if f"/projects/{p.get('id')}" not in frame]
        expect(c, len(gallery) >= 30 and not missing and not unlinked, visitor, "GET", frame_url,
               f"{len(gallery)} gallery projects; titles missing {missing[:5]}, links missing {unlinked[:5]}",
               "every gallery project's title and link in the frame")
    # every other page refuses to be framed: a sample of public, signed-in and API pages
    for person, path in ((visitor, "/"), (visitor, f"/events/{EVENT_SLUG}/results"), (visitor, "/sign-in"),
                         (visitor, "/api-docs"), (visitor, "/verify"), (visitor, f"/events/{EVENT_SLUG}/projects/prj_01"),
                         (visitor, "/api/openapi.json"), (visitor, "/embed.js"), (visitor, "/no-such-page"),
                         (organizer, f"/organize/{EVENT_SLUG}"), (judge_a, f"/judge/{EVENT_SLUG}"),
                         (participant, "/account/tokens")):
        s, _, headers = person.request("GET", u(path))
        expect(c, "deny" in (headers.get("x-frame-options") or "").lower()
               and "frame-ancestors 'none'" in (headers.get("content-security-policy") or ""),
               person, "GET", u(path), f"{s}, x-frame-options {headers.get('x-frame-options')!r}, "
               f"csp {headers.get('content-security-policy')!r}", "DENY and frame-ancestors 'none'")
    gallery_url = u(f"/events/{EVENT_SLUG}")
    s, _, headers = visitor.request("GET", gallery_url)
    if expect(c, s == 200, visitor, "GET", gallery_url, s, "200"):
        expect(c, "deny" in headers.get("x-frame-options", "").lower(), visitor, "GET", gallery_url,
               f"x-frame-options {headers.get('x-frame-options')!r}", "DENY")
        expect(c, "frame-ancestors 'none'" in headers.get("content-security-policy", ""), visitor,
               "GET", gallery_url, f"content-security-policy {headers.get('content-security-policy')!r}",
               "frame-ancestors 'none'")
    checks.append(c)

    # C7 -- the fixture-format export, and importing it back changes nothing
    c = Check("C7", "bulk export and idempotent import")
    fixtures_url = u(f"/api/events/{EVENT_ID}/export/fixtures.json")
    fixtures = None
    s, body, _ = organizer.request("GET", fixtures_url)
    if expect(c, s == 200, organizer, "GET", fixtures_url, s, "200"):
        fixtures = as_json(body)
        for key in ("event", "tracks", "judges", "teams", "projects", "scores"):
            expect(c, key in fixtures, organizer, "GET", fixtures_url, f"no '{key}' section", f"a '{key}' section")
    s, _, _ = participant.request("GET", fixtures_url)
    expect(c, s == 403, participant, "GET", fixtures_url, s, "403")
    imports_url = u("/api/imports")
    s, _, _ = participant.request("POST", imports_url, fixtures)
    expect(c, s == 403, participant, "POST", imports_url, s, "403")
    s, body, _ = organizer.request("POST", imports_url, fixtures)
    if expect(c, s == 201, organizer, "POST", imports_url, s, "201"):
        inserted = as_json(body).get("inserted")
        if expect(c, isinstance(inserted, dict) and len(inserted) > 0, organizer, "POST", imports_url,
                  f"inserted {inserted!r}", "a count for every table"):
            expect(c, all(v == 0 for v in inserted.values()), organizer, "POST", imports_url,
                   f"inserted {inserted}", "all zeros: importing what is there changes nothing")
    # Both steps below run on the published event (C4 published it). Each still isolates its own guard: the import
    # decides the rubric while it reads the file, before the publish guard at its end, so only the rubric guard
    # answers rubric_in_use; the late file brings no new criterion, so only the publish guard can refuse it. The
    # rubric step goes first: "judges have scored" was true before "results are published".
    if fixtures and fixtures.get("projects") and isinstance(fixtures.get("judges"), list) and isinstance(fixtures.get("scores"), list):
        # known-bad: the same file with a review that brings a criterion the scored event does not have
        changed = json.loads(json.dumps(fixtures))
        project = changed["projects"][0]
        changed["judges"].append({"id": "jdg_iso_extra", "name": "Iso Extra", "email": "iso-extra@example.org",
                                  "tracks": [project["track"]]})
        changed["scores"].append({"judge": "jdg_iso_extra", "project": project["id"],
                                  "criteria": {"functionality": 3, "quality": 3, "innovation": 3, "extra_iso": 3}})
        s, body, _ = organizer.request("POST", imports_url, changed)
        expect(c, s == 409 and error_code(body) == "rubric_in_use", organizer, "POST", imports_url,
               f"{s} ({error_code(body)})", "409 rubric_in_use: judges have scored, the criteria are fixed")
    else:
        expect(c, False, organizer, "GET", fixtures_url, "no projects, judges or scores to extend", "an export to extend")
    # the results are published (C4), so a file that would add to the event is refused whole, and adds nothing
    if fixtures and fixtures.get("teams") and fixtures.get("projects") and fixtures.get("tracks"):
        late_team, late_project = f"team_late_{secrets.token_hex(3)}", f"prj_late_{secrets.token_hex(3)}"
        late = json.loads(json.dumps(fixtures))
        late["teams"].append({"id": late_team, "name": "Late Team", "members": [f"late-{secrets.token_hex(3)}@example.org"]})
        late["projects"].append({"id": late_project, "team": late_team, "track": late["tracks"][0]["id"],
                                 "title": "A project added after publishing", "summary": "written by the isolation check",
                                 "repo_url": "", "submitted_at": late["projects"][0].get("submitted_at", "")})
        s, body, _ = organizer.request("POST", imports_url, late)
        expect(c, s == 409 and error_code(body) == "results_published", organizer, "POST", imports_url,
               f"{s} {error_code(body)}", "409 results_published")
        s, body, _ = visitor.request("GET", u(f"/api/events/{EVENT_ID}/projects"))
        ids = [p.get("id") for p in as_json(body).get("projects", [])]
        expect(c, s == 200 and len(ids) > 0 and late_project not in ids, visitor, "GET", u(f"/api/events/{EVENT_ID}/projects"),
               f"{s}, {len(ids)} projects, the late one {'listed' if late_project in ids else 'absent'}",
               "the gallery without the refused project")
    else:
        expect(c, False, organizer, "GET", fixtures_url, "no teams, projects or tracks to extend", "an export to extend")
    # known-bad: the file with one comment the event does not hold. An event's history (ballots, comments, pairwise
    # answers, merges, decisions, a published ranking) comes only into a new event, so the file is refused whole.
    if fixtures and fixtures.get("projects"):
        planted_id = f"cmt_iso_{secrets.token_hex(3)}"
        planted = json.loads(json.dumps(fixtures))
        planted.setdefault("comments", []).append({"id": planted_id, "project": planted["projects"][0]["id"],
                                                   "author": f"iso-planted-{secrets.token_hex(3)}@example.org",
                                                   "body": "Planted by the isolation check", "at": "2026-03-01T12:00:00Z"})
        s, body, _ = organizer.request("POST", imports_url, planted)
        expect(c, s == 409 and error_code(body) == "new_event_only", organizer, "POST", imports_url,
               f"{s} ({error_code(body)})", "409 new_event_only: an import adds no comment to an event that is here")
        s, body, _ = organizer.request("GET", fixtures_url)
        held = [x.get("id") for x in (as_json(body).get("comments") or [])] if s == 200 else []
        expect(c, s == 200 and planted_id not in held, organizer, "GET", fixtures_url,
               f"{s}, the planted comment {'present' if planted_id in held else 'absent'}", "the planted comment absent")
    else:
        expect(c, False, organizer, "GET", fixtures_url, "no projects to comment on", "an export to extend")
    checks.append(c)

    # C8 -- import a new event, then walk one person in through a personal link
    c = Check("C8", "bulk import of a new event, then a personal link")
    suffix = secrets.token_hex(3)
    trk, judge_id = f"trk_iso_{suffix}", f"jdg_iso_{suffix}"
    team_id, prj = f"team_iso_{suffix}", f"prj_iso_{suffix}"
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    captain, member, judge_email = f"captain-{suffix}@example.org", f"member-{suffix}@example.org", f"judge-{suffix}@example.org"
    # someone from the sample event, without a password, joins this team too (C12: only an administrator's link
    # may reach a person who also belongs to an event the link's organizer does not run)
    sample_member = next((m for t in reversed((fixtures or {}).get("teams", [])) for m in t.get("members", [])
                          if isinstance(m, str) and "@" in m), None)
    event_file = {
        "event": {"id": f"evt_iso_{suffix}", "name": f"Isolation Import {suffix}", "submissions_close": past},
        "tracks": [{"id": trk, "name": "Solo track"}],
        "judges": [{"id": judge_id, "name": "Iso Judge", "email": judge_email, "tracks": [trk]}],
        "teams": [{"id": team_id, "name": "Iso Team",
                   "members": [captain, member] + ([sample_member] if sample_member else [])}],
        "projects": [{"id": prj, "team": team_id, "track": trk, "title": "Isolation import project",
                      "summary": "written by the isolation check", "repo_url": "", "submitted_at": past}],
        "scores": [{"judge": judge_id, "project": prj,
                    "criteria": {"functionality": 4, "quality": 5, "innovation": 3}}],
    }
    s, body, _ = organizer.request("POST", imports_url, event_file)
    slug = None
    admin_reach = set()
    if expect(c, s == 201, organizer, "POST", imports_url, f"{s} ({error_code(body)})", "201"):
        slug = as_json(body).get("eventSlug")
        expect(c, bool(slug), organizer, "POST", imports_url, f"no eventSlug ({body[:120]!r})", "an eventSlug")
    if slug:
        s, _, _ = visitor.request("GET", u(f"/api/events/{slug}"))
        expect(c, s == 200, visitor, "GET", u(f"/api/events/{slug}"), s, "200")
        claims_url = u(f"/api/events/{slug}/claims")
        s, body, _ = organizer.request("POST", claims_url)
        token = None
        if expect(c, s == 201, organizer, "POST", claims_url, s, "201"):
            links = as_json(body).get("links", [])
            expect(c, len(links) >= 3, organizer, "POST", claims_url,
                   f"{len(links)} links", "at least 3 (the judge and both members)")
            path = next((x.get("path", "") for x in links if x.get("email") == captain), "")
            expect(c, path.startswith("/claim/"), organizer, "POST", claims_url,
                   f"path {path!r}", "a path starting with /claim/ for the captain")
            token = path[len("/claim/"):] if path.startswith("/claim/") else ""
            admin_reach = {x.get("email") for x in links}
        if token:
            claim_api = u(f"/api/claims/{token}")
            s, body, _ = visitor.request("GET", claim_api)
            if expect(c, s == 200, visitor, "GET", claim_api, s, "200"):
                expect(c, bool(as_json(body).get("email")), visitor, "GET", claim_api,
                       f"body {body[:120]!r}", "the email the link belongs to")
            claimer = Person("the imported member setting a password")
            s, body, _ = claimer.request("POST", claim_api, {"password": "isolation-check-pass"})
            if expect(c, s == 200, claimer, "POST", claim_api, f"{s} ({error_code(body)})", "200"):
                expect(c, claimer.has_cookie("session"), claimer, "POST", claim_api,
                       "no session cookie in the jar", "a session cookie")
            s, _, _ = claimer.request("POST", claim_api, {"password": "isolation-check-pass"})
            expect(c, s == 410, claimer, "POST", claim_api, s, "410 the second time")
    checks.append(c)

    # C12 -- a claim link sets the password of an account the whole portal shares, so an organizer who is not an
    # administrator gets no link for someone who also belongs to an event they do not run, and a link they got stops
    # working if the person joins such an event before using it (checked again at use). The administrator's links
    # above reached everyone: the positive control.
    c = Check("C12", "claim links: none for someone in an event the organizer does not run, checked again at use")
    co = Person("a co-organizer who is not an administrator")
    co_email = f"iso-coorg-{secrets.token_hex(4)}@example.org"
    s, body, _ = co.request("POST", u("/api/auth/sign-up"), {"name": "Iso Co-organizer", "email": co_email, "password": "isolation-check-pass"})
    ready = expect(c, s == 201, co, "POST", u("/api/auth/sign-up"), f"{s} ({error_code(body)})", "201")
    ready = ready and expect(c, bool(slug) and bool(sample_member), organizer, "POST", imports_url,
                             f"event {slug!r}, sample member {sample_member!r}", "the imported event, with a sample-event member in it")
    if ready:
        expect(c, sample_member in admin_reach, organizer, "POST", u(f"/api/events/{slug}/claims"),
               f"{sample_member} not among the administrator's links", "the administrator reaching the sample-event member")
        claims_url = u(f"/api/events/{slug}/claims")
        s, _, _ = co.request("POST", claims_url)
        expect(c, s == 403, co, "POST", claims_url, s, "403 before they are an organizer here")
        organizers_url = u(f"/api/events/{slug}/organizers")
        s, body, _ = organizer.request("POST", organizers_url, {"email": co_email})
        expect(c, s == 201, organizer, "POST", organizers_url, f"{s} ({error_code(body)})", "201 adding the co-organizer")
        s, body, _ = co.request("POST", claims_url)
        co_links = {}
        if expect(c, s == 201, co, "POST", claims_url, f"{s} ({error_code(body)})", "201"):
            data = as_json(body)
            co_links = {x.get("email"): x.get("path", "") for x in data.get("links", [])}
            elsewhere = [x.get("email") for x in data.get("elsewhere", [])]
            expect(c, sample_member not in co_links and sample_member in elsewhere, co, "POST", claims_url,
                   f"links for {sorted(co_links)}, left out {elsewhere}", f"no link for {sample_member}, named as left out")
            expect(c, judge_email in co_links and member in co_links, co, "POST", claims_url,
                   f"links for {sorted(co_links)}", "links for the judge and the member, who are only in this event")
        if judge_email in co_links and member in co_links:
            # the judge now joins a second event, which the co-organizer does not run
            other = {
                "event": {"id": f"evt_iso2_{suffix}", "name": f"Isolation Import Two {suffix}", "submissions_close": past},
                "tracks": [{"id": f"trk_iso2_{suffix}", "name": "Other track"}],
                "judges": [],
                "teams": [{"id": f"team_iso2_{suffix}", "name": "Other Team", "members": [judge_email]}],
                "projects": [{"id": f"prj_iso2_{suffix}", "team": f"team_iso2_{suffix}", "track": f"trk_iso2_{suffix}",
                              "title": "Second isolation import", "summary": "written by the isolation check",
                              "repo_url": "", "submitted_at": past}],
                "scores": [],
            }
            s, body, _ = organizer.request("POST", imports_url, other)
            if expect(c, s == 201, organizer, "POST", imports_url, f"{s} ({error_code(body)})", "201 for the second event"):
                judge_api = u(f"/api/claims/{co_links[judge_email][len('/claim/'):]}")
                s, body, _ = visitor.request("GET", judge_api)
                expect(c, s == 410 and error_code(body) == "claim_out_of_reach", visitor, "GET", judge_api,
                       f"{s} {error_code(body)}", "410 claim_out_of_reach")
                taker = Person("the judge opening the co-organizer's link")
                s, body, _ = taker.request("POST", judge_api, {"password": "isolation-check-pass"})
                expect(c, s == 410 and error_code(body) == "claim_out_of_reach" and not taker.has_cookie("session"),
                       taker, "POST", judge_api, f"{s} {error_code(body)}", "410 claim_out_of_reach and no session")
                s, body, _ = taker.request("POST", u("/api/auth/sign-in"), {"email": judge_email, "password": "isolation-check-pass"})
                expect(c, s == 401, taker, "POST", u("/api/auth/sign-in"), f"{s} {error_code(body)}",
                       "401: the refused link set no password")
            member_api = u(f"/api/claims/{co_links[member][len('/claim/'):]}")
            joiner = Person("the member opening the co-organizer's link")
            s, body, _ = joiner.request("POST", member_api, {"password": "isolation-check-pass"})
            expect(c, s == 200 and joiner.has_cookie("session"), joiner, "POST", member_api,
                   f"{s} {error_code(body)}", "200 and a session: a link for someone only in this event still works")
    checks.append(c)

    return checks
