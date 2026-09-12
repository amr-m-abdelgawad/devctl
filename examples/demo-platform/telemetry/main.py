#!/usr/bin/env python3
"""Telemetry agent — a log-shape and trace showcase for the Logs / Trace screens.

Every other demo service writes plain "LEVEL name message" lines. This one
cycles through the awkward JSON real apps actually print (pino, zap, GELF,
structlog, ECS, access logs, metrics, no message key, no severity, a leading
timestamp, nested secrets) plus a lossless OTLP/HTTP+JSON lane and a fat
multi-service W3C trace: cache miss, policy, proxy hop, invoices-api db/pdf,
identity session lookup, overlapping billing/stripe (sometimes ERROR), then
a queue producer/consumer. Filter Logs to `telemetry`, look for ◎, enter
twice for the waterfall. stdlib only.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from typing import Callable

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import traceutil as otel

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "telemetry")
OTLP = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
PROXY = os.environ.get("DEVCTL_PROXY_URL", "http://127.0.0.1:18080").rstrip("/")
PID = os.getpid()

ROUTES = [
    ("GET", "/invoices", 40),
    ("POST", "/invoices", 80),
    ("GET", "/invoices/{id}", 20),
    ("POST", "/billing/charge", 210),
    ("GET", "/healthz", 5),
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_line(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def emit_json(record: dict[str, object], prefix: str = "") -> None:
    payload = json.dumps(record, separators=(",", ":"))
    write_line(f"{prefix}{payload}" if prefix else payload)


def otlp_attr(key: str, value: object) -> dict[str, object]:
    if isinstance(value, bool):
        wrapped: dict[str, object] = {"boolValue": value}
    elif isinstance(value, int):
        wrapped = {"intValue": value}
    elif isinstance(value, float):
        wrapped = {"doubleValue": value}
    else:
        wrapped = {"stringValue": str(value)}
    return {"key": key, "value": wrapped}


def emit_pino(seq: int) -> None:
    method, path, base_ms = random.choice(ROUTES)
    status = random.choices([200, 201, 401, 429, 500], weights=[70, 10, 8, 7, 5])[0]
    pino_level = {200: 30, 201: 30, 401: 40, 429: 40, 500: 50}[status]
    emit_json({
        "level": pino_level,
        "time": int(time.time() * 1000),
        "pid": PID,
        "msg": f"{method} {path} -> {status}",
        "shape": "pino",
        "method": method,
        "path": path,
        "status": status,
        "latency_ms": round(base_ms * random.uniform(0.6, 2.4), 1),
        "seq": seq,
    })


def emit_zap(seq: int) -> None:
    emit_json({
        "level": "error",
        "ts": time.time(),
        "caller": "worker.go:90",
        "msg": "upstream invoices-worker did not respond in time",
        "shape": "zap",
        "timeout_ms": 5000,
        "attempt": seq % 4 + 1,
    })


def emit_logrus(seq: int) -> None:
    emit_json({
        "time": now_iso(),
        "level": "warning",
        "msg": "retrying invoice finalize",
        "shape": "logrus",
        "attempt": seq % 3 + 1,
        "job_id": f"job-{seq % 50:03d}",
    })


def emit_structlog(seq: int) -> None:
    emit_json({
        "event": "job_assigned",
        "level": "info",
        "shape": "structlog",
        "job_id": f"job-{seq % 50:03d}",
        "worker": "invoices-worker",
        "queue_depth": random.randint(0, 40),
    })


def emit_ecs(seq: int) -> None:
    emit_json({
        "@timestamp": now_iso(),
        "message": "handled invoice list",
        "ecs.version": "8.11",
        "shape": "ecs",
        "http": {"request": {"method": "GET", "id": f"req-{seq:06d}"}, "response": {"status_code": 200}},
        "url": {"path": "/invoices"},
    })


def emit_gelf(seq: int) -> None:
    emit_json({
        "version": "1.1",
        "host": NAME,
        "short_message": "disk pressure on invoice artifacts volume",
        "level": 3,
        "shape": "gelf",
        "facility": "invoices",
        "_used_pct": 92 + seq % 5,
    })


def emit_no_message_key(seq: int) -> None:
    emit_json({
        "shape": "no-message-key",
        "invoice_id": f"inv-{seq:04d}",
        "amount_cents": 1999 + seq % 80,
        "currency": "USD",
        "customer": "acme",
    })


def emit_no_severity(seq: int) -> None:
    emit_json({
        "msg": "scheduler tick (no level field on this logger)",
        "shape": "no-severity",
        "tick": seq,
        "queued": random.randint(0, 12),
    })


def emit_prefixed(seq: int) -> None:
    emit_json(
        {"level": "info", "msg": "booted worker pool", "shape": "prefixed", "workers": 4, "seq": seq},
        prefix=f"{now_iso()} ",
    )


def emit_access_log(seq: int) -> None:
    method, path, base_ms = random.choice(ROUTES)
    status = random.choice([200, 201, 404, 500])
    emit_json({
        "shape": "access-log",
        "method": method,
        "path": path,
        "status": status,
        "remote_ip": "127.0.0.1",
        "latency_ms": round(base_ms * random.uniform(0.4, 1.8), 1),
        "bytes": 120 + seq % 800,
        "seq": seq,
    })


def emit_metric(seq: int) -> None:
    emit_json({
        "metric_name": "invoice.queue.depth",
        "metric_type": "gauge",
        "value": random.randint(0, 40),
        "unit": "jobs",
        "shape": "metric",
        "workers": 4,
        "seq": seq,
    })


def emit_otlp_stdout(seq: int) -> None:
    emit_json({
        "timeUnixNano": str(time.time_ns()),
        "severityNumber": 9,
        "severityText": "INFO",
        "body": {"stringValue": "OTLP-JSON on stdout (heuristic lane, not /v1/logs)"},
        "shape": "otlp-stdout",
        "attributes": [
            otlp_attr("http.method", "GET"),
            otlp_attr("http.route", "/invoices"),
            otlp_attr("http.status_code", 200),
            otlp_attr("shape", "otlp-stdout"),
            otlp_attr("seq", seq),
        ],
    })


def emit_nested_secret(seq: int) -> None:
    emit_json({
        "msg": "forwarding billing webhook",
        "level": "INFO",
        "shape": "nested-secret",
        "seq": seq,
        "headers": {
            "authorization": "Bearer ya29.demo-secret-not-real",
            "content-type": "application/json",
        },
        "api_key": "sk_live_demo_secret",
        "customer_id": "cus_acme",
    })


MIN_HTTP_NS = 40_000_000


def emit_traced(
    level: str,
    msg: str,
    trace_id: str,
    span_id: str,
    seq: int,
    extra: dict[str, object] | None = None,
) -> None:
    record: dict[str, object] = {
        "level": level,
        "msg": msg,
        "shape": "traced",
        "trace_id": trace_id,
        "span_id": span_id,
        "seq": seq,
    }
    if extra:
        record.update(extra)
    emit_json(record)


def probe_proxy(trace_id: str, parent_span: str) -> int:
    req = urllib.request.Request(f"{PROXY}/fulfill", method="GET")
    req.add_header("Host", "invoices-api.local")
    req.add_header("traceparent", otel.format_traceparent(trace_id, parent_span))
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
            return int(resp.status)
    except urllib.error.HTTPError as err:
        return int(err.code)
    except (urllib.error.URLError, TimeoutError):
        return 0


def traced_roundtrip(seq: int) -> None:
    t0 = otel.time_ns()
    trace_id = otel.hex_id(16)
    root_id = otel.hex_id(8)
    cache_id = otel.hex_id(8)
    policy_id = otel.hex_id(8)
    http_id = otel.hex_id(8)
    billing_id = otel.hex_id(8)
    stripe_id = otel.hex_id(8)
    queue_id = otel.hex_id(8)
    worker_id = otel.hex_id(8)
    failed = seq % 8 == 4
    invoice_id = f"inv-{seq:04d}"

    emit_traced("INFO", f"cache miss for {invoice_id}", trace_id, cache_id, seq, {
        "invoice_id": invoice_id,
        "cache.result": "miss",
    })
    otel.export_log(
        NAME,
        f"cache miss for {invoice_id}",
        trace_id=trace_id,
        span_id=cache_id,
        attrs={"shape": "otlp-http", "cache.result": "miss", "invoice.id": invoice_id},
    )

    time.sleep(0.005)
    http_start = otel.time_ns()
    emit_traced("INFO", f"GET invoices-api.local/fulfill {invoice_id}", trace_id, http_id, seq, {
        "http.request.method": "GET",
        "url.path": "/fulfill",
        "invoice_id": invoice_id,
    })
    status = probe_proxy(trace_id, http_id)
    http_end = otel.time_ns()
    if http_end - http_start < MIN_HTTP_NS:
        http_end = http_start + 55_000_000

    emit_traced("INFO", f"billing.authorize {invoice_id} (parallel with HTTP)", trace_id, billing_id, seq, {
        "invoice_id": invoice_id,
        "peer.service": "billing",
    })
    if failed:
        emit_traced("ERROR", "stripe.charge declined", trace_id, stripe_id, seq, {
            "invoice_id": invoice_id,
            "exception.type": "CardDeclined",
            "api_key": "sk_live_demo_secret",
            "authorization": "Bearer ya29.demo-secret-not-real",
        })
        otel.export_log(
            NAME,
            "stripe.charge declined",
            trace_id=trace_id,
            span_id=stripe_id,
            severity=17,
            attrs={"shape": "otlp-http", "exception.type": "CardDeclined", "invoice.id": invoice_id},
        )
    else:
        emit_traced("INFO", "stripe.charge captured", trace_id, stripe_id, seq, {
            "invoice_id": invoice_id,
            "amount_cents": 1999,
        })
    emit_traced("INFO", f"published {invoice_id} to invoices.render", trace_id, queue_id, seq, {
        "messaging.destination": "invoices.render",
        "invoice_id": invoice_id,
    })
    emit_traced("INFO", f"worker picked up {invoice_id}", trace_id, worker_id, seq, {
        "messaging.operation": "receive",
        "invoice_id": invoice_id,
    })
    otel.export_log(
        NAME,
        f"fulfill pipeline {invoice_id} status={status}",
        trace_id=trace_id,
        span_id=root_id,
        severity=17 if failed else 9,
        attrs={"shape": "otlp-http", "http.route": "/fulfill", "error": failed, "invoice.id": invoice_id},
    )

    stripe_status = otel.STATUS_ERROR if failed else otel.STATUS_OK
    otel.export_spans(NAME, [
        otel.span(
            trace_id=trace_id, span_id=root_id, name="invoice.fulfill",
            kind=otel.KIND_SERVER, start=t0, end=otel.ms(http_end, 18),
            attrs={"invoice.id": invoice_id, "fulfill.pipeline": "demo"},
        ),
        otel.span(
            trace_id=trace_id, span_id=cache_id, parent_span_id=root_id,
            name="cache.lookup", kind=otel.KIND_INTERNAL,
            start=t0, end=otel.ms(t0, 5),
            attrs={"cache.key": f"invoice:{invoice_id}", "cache.result": "miss"},
            events=[otel.event("cache.miss", otel.ms(t0, 2), {"cache.key": f"invoice:{invoice_id}"})],
        ),
        otel.span(
            trace_id=trace_id, span_id=policy_id, parent_span_id=root_id,
            name="policy.evaluate", kind=otel.KIND_INTERNAL,
            start=otel.ms(t0, 3), end=otel.ms(t0, 16),
            attrs={"policy.name": "invoice.fulfill", "policy.decision": "allow"},
        ),
        otel.span(
            trace_id=trace_id, span_id=http_id, parent_span_id=root_id,
            name="GET invoices-api.local/fulfill", kind=otel.KIND_CLIENT,
            start=http_start, end=http_end,
            attrs={
                "http.request.method": "GET",
                "url.full": f"{PROXY}/fulfill",
                "server.address": "invoices-api.local",
                "http.response.status_code": status,
            },
        ),
        otel.span(
            trace_id=trace_id, span_id=billing_id, parent_span_id=root_id,
            name="billing.authorize", kind=otel.KIND_CLIENT,
            start=otel.ms(t0, 18), end=otel.ms(http_end, 6),
            attrs={"peer.service": "billing", "invoice.id": invoice_id},
            events=[otel.event("card.checked", otel.ms(t0, 28), {"brand": "visa"})],
        ),
        otel.span(
            trace_id=trace_id, span_id=stripe_id, parent_span_id=billing_id,
            name="stripe.charge", kind=otel.KIND_CLIENT,
            start=otel.ms(t0, 32), end=otel.ms(http_end, 2),
            status=stripe_status,
            message="card declined" if failed else "",
            attrs={
                "http.request.method": "POST",
                "server.address": "api.stripe.com",
                "invoice.id": invoice_id,
                "api_key": "sk_live_demo_secret",
                "authorization": "Bearer ya29.demo-secret-not-real",
            },
            events=[
                otel.event(
                    "exception" if failed else "charge.captured",
                    otel.ms(t0, 50),
                    {"exception.type": "CardDeclined", "exception.message": "card_declined"} if failed else {"amount_cents": 1999},
                ),
            ],
        ),
        otel.span(
            trace_id=trace_id, span_id=queue_id, parent_span_id=root_id,
            name="queue.invoice.ready", kind=otel.KIND_PRODUCER,
            start=http_end, end=otel.ms(http_end, 8),
            attrs={
                "messaging.system": "pubsub",
                "messaging.destination": "invoices.render",
                "invoice.id": invoice_id,
            },
            events=[otel.event("message.published", otel.ms(http_end, 3), {"bytes": 512})],
        ),
        otel.span(
            trace_id=trace_id, span_id=worker_id, parent_span_id=queue_id,
            name="worker.invoice.render", kind=otel.KIND_CONSUMER,
            start=otel.ms(http_end, 3), end=otel.ms(http_end, 16),
            attrs={
                "messaging.system": "pubsub",
                "messaging.operation": "receive",
                "invoice.id": invoice_id,
            },
        ),
    ])


SHAPES: list[Callable[[int], None]] = [
    emit_pino,
    emit_zap,
    emit_logrus,
    emit_structlog,
    emit_ecs,
    emit_gelf,
    emit_no_message_key,
    emit_no_severity,
    emit_prefixed,
    emit_access_log,
    emit_metric,
    emit_otlp_stdout,
    emit_nested_secret,
]


def main() -> None:
    emit_json({
        "level": "INFO",
        "msg": f"{NAME} agent starting",
        "shape": "pino",
        "pid": PID,
        "otlp": OTLP or "(unset — enable telemetry.otlp)",
        "proxy": PROXY,
    })
    seq = 0
    while True:
        seq += 1
        SHAPES[(seq - 1) % len(SHAPES)](seq)
        if seq % 4 == 0:
            traced_roundtrip(seq)
        time.sleep(random.uniform(0.45, 1.1))


if __name__ == "__main__":
    main()
