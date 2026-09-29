#!/usr/bin/env python3
"""DOGFOOD 2026 hand check: webhooks, live, against a receiver this script runs.

Usage:  python tests/webhook_live_check.py [.dogfood.toml] [--target-host host.docker.internal] [--host 127.0.0.1]
                                           [--port 0]

Any Python 3.11+, standard library only. The portal refuses private and local webhook targets, so start it for
this check with WEBHOOKS_ALLOW_PRIVATE=true (docker-compose.yml, environment), on a fresh volume:

    WEBHOOKS_ALLOW_PRIVATE: "true"   # under portal: environment: in docker-compose.yml, then
    docker compose down -v && docker compose up -d

Leave the setting off everywhere else: isolation_check.py (C3) checks that private targets are refused, so it
belongs to a portal started without it. This script listens on --host (default 127.0.0.1; a free port unless
--port names one) and gives the portal the URL http://<target-host>:<port>/. Docker Desktop (macOS, Windows)
forwards host.docker.internal to this machine's 127.0.0.1, so the defaults work there. On Linux, add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the portal service and pass --host 0.0.0.0: there
host.docker.internal is the Docker bridge address (typically 172.17.0.1), which a receiver on 127.0.0.1 never
hears (the same as scripts/webhook-receiver.mjs). 0.0.0.0 listens on every interface for the minute the check runs.
For a portal run with `npm run dev` on this machine, pass --target-host 127.0.0.1.

What it checks, on what actually arrives: the Dogfood-Signature header is HMAC-SHA256 over `${t}.${body}` with the
webhook's secret and a fresh timestamp (and a wrong secret or a changed body does not verify); a delivery the
receiver answers 500 comes again about 10 s later with the same delivery id and body, signed again, and is then
logged as delivered; an audited change arrives with its audit row's id and hash; after the secret is rotated,
deliveries verify with the new secret only. It writes a webhook and a comment, so run it on a fresh instance.
"""

import argparse
import csv
import hashlib
import hmac
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tomllib

from isolation_check import Check, Person, as_json, error_code, expect

EVENT_ID = "evt_01"


class Receiver:
    """Records every request; answers 500 to the first attempt of each delivery id listed in `refuse_first`."""

    def __init__(self, host, port):
        self.arrived = []
        self.lock = threading.Lock()
        self.refuse_first = set()
        self.refused = set()
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                headers = {k.lower(): v for k, v in self.headers.items()}
                delivery = headers.get("dogfood-delivery", "")
                with receiver.lock:
                    receiver.arrived.append({"at": time.time(), "path": self.path, "headers": headers, "body": body})
                    refuse = headers.get("dogfood-event") in receiver.refuse_first and delivery not in receiver.refused
                    if refuse:
                        receiver.refused.add(delivery)
                self.send_response(500 if refuse else 200)
                self.send_header("content-type", "text/plain")
                self.end_headers()
                self.wfile.write(b"refused on purpose\n" if refuse else b"ok\n")

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def wait_for(self, match, count=1, within=20.0):
        """The requests that match, once there are `count` of them, or what there is after `within` seconds."""
        end = time.monotonic() + within
        while True:
            with self.lock:
                got = [r for r in self.arrived if match(r)]
            if len(got) >= count or time.monotonic() > end:
                return got
            time.sleep(0.2)

    def stop(self):
        self.server.shutdown()


def signed(secret, body, header, tolerance=300):
    """What a receiver checks: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>, and t no older than 5 minutes."""
    parts = dict(kv.split("=", 1) for kv in (header or "").split(",") if "=" in kv)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs(time.time() - t) > tolerance or not parts.get("v1"):
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, parts["v1"])


def run_checks(cfg, target_host, port, host="127.0.0.1"):
    base = cfg["portal"]["base_url"].rstrip("/")
    auth = cfg.get("auth", {})

    def u(path):
        return base + path

    organizer = Person("the organizer", auth.get("organizer"))
    judge_a = Person("judge_a", auth.get("judge_a"))
    receiver = Receiver(host, port)
    target = f"http://{target_host}:{receiver.port}/dogfood"
    checks = []
    hooks_url = u(f"/api/events/{EVENT_ID}/webhooks")

    try:
        # W1 -- a test delivery arrives, signed with the webhook's secret
        c = Check("W1", "a test delivery arrives signed with the webhook's secret, and nothing else verifies")
        s, body, _ = organizer.request("POST", hooks_url, {"url": target, "actions": ["comment.post"]})
        hook = secret = None
        if s == 422:
            expect(c, False, organizer, "POST", hooks_url, f"422 ({as_json(body).get('message', '')[:120]})",
                   "201: start the portal with WEBHOOKS_ALLOW_PRIVATE=true for this check")
        elif expect(c, s == 201, organizer, "POST", hooks_url, f"{s} ({error_code(body)})", "201"):
            hook, secret = as_json(body).get("id"), as_json(body).get("secret", "")
        checks.append(c)
        if not hook:
            return checks
        one = u(f"/api/events/{EVENT_ID}/webhooks/{hook}")
        receiver.refuse_first.add("webhook.test")
        s, _, _ = organizer.request("POST", one + "/test")
        expect(c, s == 200, organizer, "POST", one + "/test", s, "200")
        first = receiver.wait_for(lambda r: r["headers"].get("dogfood-event") == "webhook.test", 1, 15)
        test_id = None
        if expect(c, len(first) >= 1, organizer, "POST", target, "nothing arrived within 15 s", "the test delivery"):
            r = first[0]
            payload = json.loads(r["body"].decode("utf-8"))
            test_id = r["headers"].get("dogfood-delivery")
            header = r["headers"].get("dogfood-signature", "")
            expect(c, r["headers"].get("content-type", "").startswith("application/json"), organizer, "POST", target,
                   f"content-type {r['headers'].get('content-type')!r}", "application/json")
            expect(c, bool(test_id) and payload.get("id") == test_id and payload.get("type") == "webhook.test",
                   organizer, "POST", target, f"delivery {test_id!r}, payload id {payload.get('id')!r}, type {payload.get('type')!r}",
                   "the delivery id in the header and the body, type webhook.test")
            expect(c, signed(secret, r["body"], header), organizer, "POST", target,
                   f"signature {header[:40]!r} does not verify with the secret", "a valid signature")
            wrong = secret[:-1] + ("A" if secret[-1] != "A" else "B")
            expect(c, not signed(wrong, r["body"], header), organizer, "POST", target,
                   "it verifies with a wrong secret too", "no match with a wrong secret (the known-bad)")
            expect(c, not signed(secret, r["body"] + b" ", header), organizer, "POST", target,
                   "it verifies for a changed body too", "no match for a changed body")
            t = int(dict(kv.split("=", 1) for kv in header.split(",") if "=" in kv).get("t", "0"))
            expect(c, abs(time.time() - t) < 60, organizer, "POST", target, f"t {t}, {abs(time.time() - t):.0f} s off",
                   "a timestamp from the moment it was sent")

        # W2 -- the receiver answered that first attempt 500: it comes again, signed again, then counts as delivered
        c = Check("W2", "a refused delivery comes again about 10 s later, signed again, then logged delivered")
        if test_id:
            both = receiver.wait_for(lambda r: r["headers"].get("dogfood-delivery") == test_id, 2, 25)
            if expect(c, len(both) >= 2, organizer, "POST", target, f"{len(both)} attempt(s) within 25 s", "a second attempt"):
                a, b = both[0], both[1]
                expect(c, a["body"] == b["body"], organizer, "POST", target, "a different body the second time", "the same body")
                expect(c, signed(secret, b["body"], b["headers"].get("dogfood-signature", "")), organizer, "POST", target,
                       "the second attempt's signature does not verify", "a valid signature")
                gap = b["at"] - a["at"]
                expect(c, 8 <= gap <= 20, organizer, "POST", target, f"{gap:.1f} s between the attempts", "about 10 s")
                log = []
                for _ in range(20):
                    s, body, _ = organizer.request("GET", one + "/deliveries")
                    log = [d for d in as_json(body).get("deliveries", []) if d.get("id") == test_id]
                    if log and log[0].get("status") == "delivered":
                        break
                    time.sleep(0.5)
                d = log[0] if log else {}
                expect(c, (d.get("status"), d.get("attempts"), d.get("responseStatus")) == ("delivered", 2, 200),
                       organizer, "GET", one + "/deliveries",
                       f"status {d.get('status')!r}, attempts {d.get('attempts')!r}, response {d.get('responseStatus')!r}",
                       "delivered on the second attempt, answered 200")
        else:
            expect(c, False, organizer, "POST", target, "no test delivery arrived (W1)", "a delivery to follow")
        checks.append(c)

        # W3 -- an audited change: the comment arrives with its audit row's id and hash
        c = Check("W3", "an audited change arrives signed, with its audit row's id and hash")
        comments_url = u("/api/projects/prj_03/comments")
        s, body, _ = judge_a.request("POST", comments_url, {"body": "webhook live check: a comment to deliver"})
        comment_id = as_json(body).get("id") if s == 201 else None
        expect(c, bool(comment_id), judge_a, "POST", comments_url, f"{s} ({error_code(body)})", "201 with an id")
        if comment_id:
            got = receiver.wait_for(lambda r: r["headers"].get("dogfood-event") == "comment.post"
                                    and f'"{comment_id}"'.encode() in r["body"], 1, 15)
            if expect(c, len(got) >= 1, organizer, "POST", target, "no comment.post delivery within 15 s", "the comment's delivery"):
                r = got[0]
                data = json.loads(r["body"].decode("utf-8")).get("data", {})
                expect(c, signed(secret, r["body"], r["headers"].get("dogfood-signature", "")), organizer, "POST", target,
                       "the signature does not verify", "a valid signature")
                s, body, _ = organizer.request("GET", u(f"/api/events/{EVENT_ID}/export/audit.csv"))
                row = next((x for x in csv.DictReader(io.StringIO(body)) if x.get("id") == str(data.get("auditId"))), None)
                expect(c, row is not None and row.get("action") == "comment.post" and row.get("hash") == data.get("hash"),
                       organizer, "GET", u(f"/api/events/{EVENT_ID}/export/audit.csv"),
                       f"row {data.get('auditId')!r}: {None if row is None else (row.get('action'), row.get('hash'))!r}, payload hash {data.get('hash')!r}",
                       "the comment.post row, with the payload's hash")
        checks.append(c)

        # W4 -- rotate the secret: what arrives next verifies with the new secret and not with the old one
        c = Check("W4", "after the secret is rotated, deliveries verify with the new secret only")
        s, body, _ = organizer.request("POST", one + "/rotate-secret")
        new_secret = as_json(body).get("secret", "") if s == 200 else ""
        if expect(c, new_secret.startswith("whsec_") and new_secret != secret, organizer, "POST", one + "/rotate-secret",
                  f"{s}, secret {new_secret[:10]!r}", "200 and a new secret"):
            before = len(receiver.wait_for(lambda r: r["headers"].get("dogfood-event") == "webhook.test", 0, 0))
            s, _, _ = organizer.request("POST", one + "/test")
            expect(c, s == 200, organizer, "POST", one + "/test", s, "200")
            tests = receiver.wait_for(lambda r: r["headers"].get("dogfood-event") == "webhook.test", before + 1, 15)
            if expect(c, len(tests) > before, organizer, "POST", target, "no second test delivery within 15 s", "a test delivery"):
                r = tests[-1]
                header = r["headers"].get("dogfood-signature", "")
                expect(c, signed(new_secret, r["body"], header) and not signed(secret, r["body"], header), organizer,
                       "POST", target, f"new secret {signed(new_secret, r['body'], header)}, old secret {signed(secret, r['body'], header)}",
                       "new secret True, old secret False")
        checks.append(c)
        s, _, _ = organizer.request("POST", one + "/disable")
    finally:
        receiver.stop()
    return checks


def main():
    ap = argparse.ArgumentParser(description="DOGFOOD 2026 webhook live check")
    ap.add_argument("config", nargs="?", default=".dogfood.toml")
    ap.add_argument("--target-host", default="host.docker.internal",
                    help="the name the portal uses to reach this machine (default host.docker.internal)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="the address to listen on (default 127.0.0.1; on Linux 0.0.0.0, see the header)")
    ap.add_argument("--port", type=int, default=0, help="the port to listen on (default: any free port)")
    args = ap.parse_args()
    with open(args.config, "rb") as f:
        cfg = tomllib.load(f)
    print("DOGFOOD 2026 webhook live check")
    print(f"portal: {cfg['portal']['base_url']}")
    print("needs a portal started with WEBHOOKS_ALLOW_PRIVATE=true; writes a webhook and a comment")
    print()
    print(f"receiver: listening on {args.host}, reached by the portal as {args.target_host}")
    checks = run_checks(cfg, args.target_host, args.port, args.host)
    width = max(len(c.label) for c in checks) + 2
    for c in checks:
        print(f"{c.number:<4} {c.label} {'.' * (width - len(c.label))} {'PASS' if c.ok else 'FAIL'}")
        for line in c.detail:
            print(f"       {line}")
    passed = sum(1 for c in checks if c.ok)
    print()
    print(f"webhooks live: {passed} of {len(checks)} checks passed")
    return 0 if passed == len(checks) and len(checks) == 4 else 1


if __name__ == "__main__":
    sys.exit(main())
