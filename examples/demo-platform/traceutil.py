"""Tiny OTLP/HTTP+JSON helpers for the demo platform. stdlib only."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

KIND_INTERNAL = 1
KIND_SERVER = 2
KIND_CLIENT = 3
KIND_PRODUCER = 4
KIND_CONSUMER = 5
STATUS_OK = 1
STATUS_ERROR = 2


def otlp_endpoint() -> str:
    return os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")


def hex_id(nbytes: int) -> str:
    return os.urandom(nbytes).hex()


def parse_traceparent(header: str) -> tuple[str, str]:
    parts = header.strip().split("-")
    if len(parts) != 4 or parts[0] != "00" or len(parts[1]) != 32 or len(parts[2]) != 16:
        return "", ""
    return parts[1], parts[2]


def format_traceparent(trace_id: str, span_id: str) -> str:
    return f"00-{trace_id}-{span_id}-01"


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


def post_json(url: str, payload: dict[str, object]) -> bool:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        urllib.request.urlopen(req, timeout=0.4).read()
        return True
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return False


def span(
    *,
    trace_id: str,
    span_id: str,
    name: str,
    kind: int,
    start: int,
    end: int,
    parent_span_id: str = "",
    status: int = STATUS_OK,
    message: str = "",
    attrs: dict[str, object] | None = None,
    events: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    rec: dict[str, object] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": kind,
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(end),
        "status": {"code": status, **({"message": message} if message else {})},
        "attributes": [otlp_attr(key, value) for key, value in (attrs or {}).items()],
        "events": events or [],
    }
    if parent_span_id:
        rec["parentSpanId"] = parent_span_id
    return rec


def event(name: str, when: int, attrs: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "timeUnixNano": str(when),
        "name": name,
        "attributes": [otlp_attr(key, value) for key, value in (attrs or {}).items()],
    }


def export_spans(service: str, spans: list[dict[str, object]], endpoint: str = "") -> None:
    dest = endpoint or otlp_endpoint()
    if dest == "" or len(spans) == 0:
        return
    post_json(f"{dest}/v1/traces", {
        "resourceSpans": [{
            "resource": {"attributes": [otlp_attr("service.name", service)]},
            "scopeSpans": [{"scope": {"name": f"demo-platform/{service}"}, "spans": spans}],
        }],
    })


def export_log(
    service: str,
    body: str,
    *,
    trace_id: str = "",
    span_id: str = "",
    severity: int = 9,
    attrs: dict[str, object] | None = None,
    endpoint: str = "",
) -> None:
    dest = endpoint or otlp_endpoint()
    if dest == "":
        return
    rec: dict[str, object] = {
        "timeUnixNano": str(time_ns()),
        "severityNumber": severity,
        "body": {"stringValue": body},
        "attributes": [otlp_attr(key, value) for key, value in (attrs or {}).items()],
    }
    if trace_id:
        rec["traceId"] = trace_id
    if span_id:
        rec["spanId"] = span_id
    post_json(f"{dest}/v1/logs", {
        "resourceLogs": [{
            "resource": {"attributes": [otlp_attr("service.name", service)]},
            "scopeLogs": [{"scope": {"name": f"demo-platform/{service}"}, "logRecords": [rec]}],
        }],
    })


def time_ns() -> int:
    return time.time_ns()


def ms(ns: int, millis: float) -> int:
    return ns + int(millis * 1_000_000)
