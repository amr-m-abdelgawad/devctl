#!/usr/bin/env python3
"""Telemetry agent — emits one JSON object per line to stdout, pino/zap-style.

No other service in this example logs this way (they all write plain
"LEVEL name message" lines); this one exists specifically to exercise
devctl's structured-log parsing in the Logs screen — point it at the Logs
tab and each record's `msg`/`level`/`request_id` populate the normal
columns instead of showing the raw JSON blob, with the full record (extra
fields included) still available in the log details overlay (enter) or via
click-through. stdlib only.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "telemetry")

ROUTES = [
    ("GET", "/invoices", 40),
    ("POST", "/invoices", 80),
    ("GET", "/invoices/{id}", 20),
    ("POST", "/billing/charge", 210),
    ("GET", "/healthz", 5),
]
LEVEL_FOR_STATUS = {200: "INFO", 201: "INFO", 401: "WARN", 429: "WARN", 500: "ERROR", 503: "ERROR"}


def emit(level: str, msg: str, **fields: object) -> None:
    record = {
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "msg": msg,
        "service": NAME,
        **fields,
    }
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def synthetic_request(seq: int) -> None:
    method, path, base_ms = random.choice(ROUTES)
    status = random.choices([200, 201, 401, 429, 500], weights=[70, 10, 8, 7, 5])[0]
    latency_ms = round(base_ms * random.uniform(0.6, 2.4), 1)
    request_id = f"req-{seq:06d}"
    emit(
        LEVEL_FOR_STATUS.get(status, "INFO"),
        f"{method} {path} -> {status}",
        request_id=request_id,
        method=method,
        path=path,
        status=status,
        latency_ms=latency_ms,
    )
    if status == 500:
        emit("ERROR", "upstream invoices-worker did not respond in time", request_id=request_id, timeout_ms=5000)
    elif status == 429:
        emit("WARN", "rate limit exceeded for client", request_id=request_id, limit="100/min")


def main() -> None:
    emit("INFO", f"{NAME} agent starting", pid=os.getpid())
    seq = 0
    while True:
        seq += 1
        synthetic_request(seq)
        if seq % 10 == 0:
            emit("DEBUG", "queue depth sample", queue_depth=random.randint(0, 40), workers=4)
        time.sleep(random.uniform(0.4, 1.2))


if __name__ == "__main__":
    main()
