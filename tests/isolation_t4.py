#!/usr/bin/env python3
"""DOGFOOD 2026 isolation hand-check, Section C: the T4 features.

Runs after Sections A and B of isolation_check.py on the same instance (the
driver wires them together), so voting is closed, one comment is hidden and the
results are not yet published when it starts. It then publishes the sample
event, so the instance is spent for A and B afterwards.

Covers, as numbered checks: the OpenAPI document and bearer auth, a settings
round trip, webhooks (private targets refused, a change queued with its audit
hash), signed records end to end (publish, issue, verify, tamper), the offline
verifier script, the embed widget and its frame headers, and bulk import and
export with personal claim links, and pairwise judging (C9, run before C4 because
publishing makes the judging mode final). Standard library only.
"""

import csv
import io
import json
import secrets
import shutil
import subprocess
import tempfile
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
    c = Check("C", "REST API: OpenAPI document and bearer auth")
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
    checks.append(c)

    # C2 -- a settings round trip: read the prizes from event.json, PUT them back
    c = Check("C", "REST API: settings round trip")
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
    checks.append(c)

    # C3 -- webhooks: private target refused, a change queued in the same transaction
    c = Check("C", "webhooks: private targets refused, a change queued with its audit hash")
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

    # C9 -- pairwise judging (JUDGING.md "Pairwise mode"). It runs here, before C4, because
    # publishing makes the judging mode final; it puts the event back in scores mode after.
    c = Check("C", "pairwise judging: only judges answer, only the question asked, peers isolated, only organizers rank")
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
        s, body, _ = judge_a.request("POST", undo_url, {"trackId": question["trackId"]})
        expect(c, s == 409 and error_code(body) == "nothing_to_undo", judge_a, "POST", undo_url,
               f"{s} {error_code(body)}", "409 nothing_to_undo")
    if switched:
        s, _, _ = organizer.request("PUT", mode_url, {"mode": "scores", "reason": "isolation check C9 done"})
        expect(c, s == 200, organizer, "PUT", mode_url, s, "200 back to scores for C4")
    checks.append(c)

    # C4 -- records: settle the three decisions, publish, issue, verify, tamper
    c = Check("C", "records: publish, issue, verify, tamper")
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

    # C5 -- the same check offline, with scripts/verify-record.mjs and pinned keys
    c = Check("C", "records: checked offline with scripts/verify-record.mjs")
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
    c = Check("C", "embed: the widget and its frame headers")
    s, body, _ = visitor.request("GET", u("/embed.js"))
    if expect(c, s == 200, visitor, "GET", u("/embed.js"), s, "200"):
        expect(c, "data-event" in body, visitor, "GET", u("/embed.js"),
               "no 'data-event' in the script", "the data-event attribute")
    frame_url = u(f"/embed/{EVENT_SLUG}")
    s, _, headers = visitor.request("GET", frame_url)
    if expect(c, s == 200, visitor, "GET", frame_url, s, "200"):
        expect(c, "frame-ancestors *" in headers.get("content-security-policy", ""), visitor,
               "GET", frame_url, f"content-security-policy {headers.get('content-security-policy')!r}",
               "frame-ancestors *")
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
    c = Check("C", "bulk export and idempotent import")
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
    checks.append(c)

    # C8 -- import a new event, then walk one person in through a personal link
    c = Check("C", "bulk import of a new event, then a personal link")
    suffix = secrets.token_hex(3)
    trk, judge_id = f"trk_iso_{suffix}", f"jdg_iso_{suffix}"
    team_id, prj = f"team_iso_{suffix}", f"prj_iso_{suffix}"
    past = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    event_file = {
        "event": {"id": f"evt_iso_{suffix}", "name": f"Isolation Import {suffix}", "submissions_close": past},
        "tracks": [{"id": trk, "name": "Solo track"}],
        "judges": [{"id": judge_id, "name": "Iso Judge", "email": f"judge-{suffix}@example.org", "tracks": [trk]}],
        "teams": [{"id": team_id, "name": "Iso Team",
                   "members": [f"captain-{suffix}@example.org", f"member-{suffix}@example.org"]}],
        "projects": [{"id": prj, "team": team_id, "track": trk, "title": "Isolation import project",
                      "summary": "written by the isolation check", "repo_url": "", "submitted_at": past}],
        "scores": [{"judge": judge_id, "project": prj,
                    "criteria": {"functionality": 4, "quality": 5, "innovation": 3}}],
    }
    s, body, _ = organizer.request("POST", imports_url, event_file)
    slug = None
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
            path = links[0].get("path", "") if links else ""
            expect(c, path.startswith("/claim/"), organizer, "POST", claims_url,
                   f"path {path!r}", "a path starting with /claim/")
            token = path[len("/claim/"):] if path.startswith("/claim/") else ""
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

    return checks
