"""Tiny OTLP/HTTP+JSON helpers for the demo platform. stdlib only."""

from __future__ import annotations

import json
import os
import socketserver
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

class LoopbackHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer without HTTPServer.server_bind's socket.getfqdn().

    That reverse DNS lookup runs after bind and before the server accepts
    connections; on macOS it can stall for many seconds, so the service
    looks hung and misses its health check. server_name is unused here.
    """

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


KIND_INTERNAL = 1
KIND_SERVER = 2
KIND_CLIENT = 3
KIND_PRODUCER = 4
KIND_CONSUMER = 5
STATUS_OK = 1
STATUS_ERROR = 2


def otlp_endpoint() -> str:
    return os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")


def hub_request(
    base: str,
    path: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> urllib.request.Request:
    """Hit `base`+path, rewriting `*.local` hub URLs through DEVCTL_PROXY_URL.

    Python (and Vite) cannot resolve `invoices-api.local` without /etc/hosts, so
    the demo uses the injected proxy URL plus a Host header — the same pattern
    as the telemetry fulfill probe. Callers that already use a loopback URL are
    left unchanged.
    """
    parsed = urlparse(base)
    proxy = os.environ.get("DEVCTL_PROXY_URL", "").rstrip("/")
    service = os.environ.get("DEVCTL_SERVICE_NAME", "")
    suffix = path if path.startswith("/") else f"/{path}"
    extra = dict(headers or {})
    if proxy and parsed.hostname and parsed.hostname.endswith(".local"):
        url = f"{proxy}{suffix}"
        extra.setdefault("Host", parsed.hostname)
    else:
        url = f"{base.rstrip('/')}{suffix}"
    if service:
        extra.setdefault("X-Devctl-Service", service)
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in extra.items():
        req.add_header(key, value)
    return req


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
