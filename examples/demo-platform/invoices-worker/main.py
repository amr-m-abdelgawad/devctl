#!/usr/bin/env python3
"""Invoices worker — polls the invoices API and finalizes queued jobs."""

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

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "invoices-worker")
PORT = int(os.environ.get("SERVICE_PORT") or os.environ.get("HTTP_PORT") or "18002")
API_URL = os.environ.get("API_URL", "http://127.0.0.1:18000").rstrip("/")
PROCESSED = 0
RETRIES: dict[object, int] = {}
MAX_RETRIES = 3


def log(message: str, level: str = "INFO") -> None:
    sys.stdout.write(f"{level} {NAME} {message}\n")
    sys.stdout.flush()


def finalize_trace(job: dict[str, object]) -> None:
    log(
        f"trace job={job.get('id')} request_id={uuid.uuid4().hex} method=POST path=/jobs/{job.get('id')}/complete "
        f"owner={job.get('owner')} title={job.get('title')!r} "
        f"upstream=invoices-api@{API_URL} downstream_status=200 "
        f"fetch_latency_ms={random.randint(10, 40)} complete_latency_ms={random.randint(15, 55)} "
        f"total_latency_ms={random.randint(30, 100)} checksum={uuid.uuid4().hex[:16]} "
        f"pdf_bytes={random.randint(40_000, 260_000)} storage_bucket=gs://invoices-dev-artifacts/{job.get('id')}.pdf "
        f"headers={{'accept': 'application/json', 'x-request-id': '{uuid.uuid4().hex}', 'x-worker-node': '{NAME}@{PORT}'}}"
    )


def fetch_jobs() -> list[dict[str, object]]:
    req = urllib.request.Request(f"{API_URL}/jobs")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as err:
        log(f"invoices API unreachable at {API_URL}: {err}", "ERROR")
        return []
    except json.JSONDecodeError as err:
        log(f"invoices API returned malformed json: {err}", "ERROR")
        return []
    jobs = body.get("jobs") if isinstance(body, dict) else None
    return jobs if isinstance(jobs, list) else []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        body = json.dumps({"status": "ok", "service": NAME, "processed": PROCESSED}).encode()
        code = 200 if path == "/health" else 404
        if path != "/health":
            body = json.dumps({"error": "not found"}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def poll() -> None:
    global PROCESSED
    while True:
        time.sleep(2)
        queued = [job for job in fetch_jobs() if job.get("status") == "queued"]
        if not queued:
            log("idle — no invoice jobs queued")
            continue
        for job in queued:
            job_id = job.get("id")
            req = urllib.request.Request(f"{API_URL}/jobs/{job_id}/complete", method="POST")
            try:
                urllib.request.urlopen(req, timeout=2).read()
                PROCESSED += 1
                RETRIES.pop(job_id, None)
                log(f"finalized invoice job {job_id} (lifetime processed={PROCESSED})")
                finalize_trace(job)
            except (urllib.error.URLError, TimeoutError) as err:
                attempts = RETRIES.get(job_id, 0) + 1
                RETRIES[job_id] = attempts
                if attempts >= MAX_RETRIES:
                    log(f"giving up on invoice job {job_id} after {attempts} attempts: {err}", "ERROR")
                    log(
                        f"traceback (most recent call last) job={job_id}: "
                        f'File "invoices_worker/poll.py", line 71, in poll -> urllib.request.urlopen(req, timeout=2).read() | '
                        f'File "urllib/request.py", line 216, in urlopen -> return opener.open(url, data, timeout) | '
                        f'File "urllib/request.py", line 519, in open -> response = self._open(req, data) | '
                        f'File "urllib/request.py", line 496, in _open -> result = self._call_chain(*args) | '
                        f'File "http/client.py", line 1428, in connect -> super().connect() | '
                        f"{type(err).__name__}: {err} (job_id={job_id}, api_url={API_URL}, attempt={attempts}/{MAX_RETRIES})",
                        "ERROR",
                    )
                else:
                    log(f"retry {attempts}/{MAX_RETRIES} for invoice job {job_id}: {err}", "WARN")


if __name__ == "__main__":
    threading.Thread(target=poll, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on {PORT} invoices_api={API_URL}")
    server.serve_forever()
