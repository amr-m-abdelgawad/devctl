#!/usr/bin/env python3
"""Invoices API — job queue for invoice generation. stdlib only, talks to identity."""

from __future__ import annotations

import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "invoices-api")
PORT = int(os.environ.get("SERVICE_PORT") or os.environ.get("HTTP_PORT") or "18000")
AUTH_URL = os.environ.get("AUTH_URL", "http://127.0.0.1:18001").rstrip("/")
JOBS: list[dict[str, object]] = []
NEXT_ID = 1
IDENTITY_FAILURES = 0


def log(message: str, level: str = "INFO") -> None:
    sys.stdout.write(f"{level} {NAME} {message}\n")
    sys.stdout.flush()


def trace_id() -> str:
    return uuid.uuid4().hex


def trace_line(job_id: object, user: str, title: str, content_length: int, user_agent: str) -> None:
    log(
        f"trace job={job_id} request_id={trace_id()} method=POST path=/jobs "
        f"user={user} title={title!r} content_length={content_length} "
        f"upstream=identity@{AUTH_URL} downstream_call=/whoami downstream_status=200 "
        f"downstream_latency_ms={random.randint(15, 60)} total_latency_ms={random.randint(20, 90)} "
        f"user_agent={user_agent!r} "
        f"headers={{'content-type': 'application/json', 'accept': 'application/json', "
        f"'x-forwarded-for': '127.0.0.1', 'x-request-id': '{trace_id()}', 'x-client-version': '0.1.0'}}"
    )


def queue_job(title: str, user: str, content_length: int, user_agent: str) -> dict[str, object]:
    global NEXT_ID
    job: dict[str, object] = {"id": NEXT_ID, "title": title, "owner": user, "status": "queued"}
    NEXT_ID += 1
    JOBS.append(job)
    log(f"queued invoice job {job['id']} ({title!r}) for {user}")
    trace_line(job["id"], user, title, content_length, user_agent)
    return job


def whoami(token: str) -> dict[str, object] | None:
    global IDENTITY_FAILURES
    req = urllib.request.Request(
        f"{AUTH_URL}/whoami",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as err:
        IDENTITY_FAILURES += 1
        log(f"identity service unreachable at {AUTH_URL}: {err}", "ERROR")
        return None
    except json.JSONDecodeError as err:
        log(f"identity service returned malformed json: {err}", "ERROR")
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _user(self) -> str | None:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        identity = whoami(auth.removeprefix("Bearer ").strip())
        if identity is None:
            return None
        user = identity.get("user")
        return str(user) if user else None

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"status": "ok", "service": NAME, "auth": AUTH_URL})
            return
        if path == "/jobs":
            self._json(200, {"jobs": JOBS})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        global NEXT_ID
        path = urlparse(self.path).path
        if path.startswith("/jobs/") and path.endswith("/complete"):
            job_id = path.removeprefix("/jobs/").removesuffix("/complete")
            for job in JOBS:
                if str(job.get("id")) == job_id:
                    job["status"] = "done"
                    log(f"invoice job {job_id} completed for {job.get('owner')}")
                    self._json(200, job)
                    return
            log(f"complete requested for unknown job {job_id}", "WARN")
            self._json(404, {"error": "job not found"})
            return
        if path != "/jobs":
            self._json(404, {"error": "not found"})
            return
        user = self._user()
        if user is None:
            log(f"{self.address_string()} rejected: no valid session for /jobs", "WARN")
            self._json(401, {"error": "sign in through identity first"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            log("received malformed job payload; using defaults", "WARN")
            payload = {}
        title = str(payload.get("title") or "untitled invoice run")
        job = queue_job(title, user, length, self.headers.get("User-Agent", "unknown"))
        self._json(201, job)


RECONCILIATION_TITLES = [
    "nightly reconciliation sweep — Acme Corp",
    "nightly reconciliation sweep — Beta LLC",
    "nightly reconciliation sweep — Gamma Industries",
    "dunning re-run for overdue accounts",
]


def heartbeat() -> None:
    tick = 0
    while True:
        time.sleep(5)
        tick += 1
        queued = sum(1 for job in JOBS if job.get("status") == "queued")
        if IDENTITY_FAILURES > 0 and queued > 3:
            log(f"heartbeat jobs={len(JOBS)} queued={queued} — backlog growing while identity is unreachable", "WARN")
        else:
            log(f"heartbeat jobs={len(JOBS)} queued={queued}")
        if tick % 3 == 0:
            title = RECONCILIATION_TITLES[(tick // 3 - 1) % len(RECONCILIATION_TITLES)]
            queue_job(title, "billing-cron@internal", 0, "invoices-api/scheduler")


if __name__ == "__main__":
    threading.Thread(target=heartbeat, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on {PORT} identity={AUTH_URL}")
    server.serve_forever()
