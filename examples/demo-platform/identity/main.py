#!/usr/bin/env python3
"""Identity service — session login, token issuance, whoami. stdlib only.

Doctor /health stays instant. When a request arrives with a W3C traceparent
(the telemetry showcase via invoices-api), /health sleeps briefly and
exports nested OTLP spans so the waterfall has a real downstream hop.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import traceutil as otel

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "identity")
PORT = int(os.environ.get("SERVICE_PORT") or os.environ.get("HTTP_PORT") or "18001")
TOKENS: dict[str, str] = {}
FAILED_LOOKUPS = 0
TRACE_HEALTH_S = 0.018


def log(message: str, level: str = "INFO") -> None:
    sys.stdout.write(f"{level} {NAME} {message}\n")
    sys.stdout.flush()


def audit_line(event: str, user: str, remote: str, user_agent: str) -> None:
    log(
        f"audit event={event} user={user} "
        f"remote={remote} user_agent={user_agent!r} "
        f"scopes=['invoices:read', 'invoices:write', 'billing:read'] "
        f"issued_at={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} expires_in=3600 "
        f"session_store=in-memory active_sessions={len(TOKENS)} node={NAME}@{PORT}"
    )


def emit_json(record: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def maybe_trace_health(handler: BaseHTTPRequestHandler) -> None:
    trace_id, parent_span = otel.parse_traceparent(handler.headers.get("traceparent", ""))
    if not trace_id:
        return
    server_id = otel.hex_id(8)
    lookup_id = otel.hex_id(8)
    setattr(handler, "_local_span", server_id)
    t0 = otel.time_ns()
    emit_json({
        "msg": "session.store.lookup",
        "level": "INFO",
        "shape": "traced",
        "trace_id": trace_id,
        "span_id": lookup_id,
        "session_store": "in-memory",
    })
    time.sleep(TRACE_HEALTH_S)
    end = otel.time_ns()
    otel.export_spans(NAME, [
        otel.span(
            trace_id=trace_id, span_id=server_id, parent_span_id=parent_span,
            name="GET /health", kind=otel.KIND_SERVER, start=t0, end=end,
            attrs={"http.request.method": "GET", "url.path": "/health", "http.route": "/health"},
        ),
        otel.span(
            trace_id=trace_id, span_id=lookup_id, parent_span_id=server_id,
            name="session.store.lookup", kind=otel.KIND_INTERNAL,
            start=otel.ms(t0, 2), end=otel.ms(t0, 14),
            attrs={"session.store": "in-memory", "session.active": len(TOKENS)},
            events=[otel.event("session.hit", otel.ms(t0, 8), {"cache": "local"})],
        ),
    ])
    otel.export_log(
        NAME,
        "session lookup on traced health probe",
        trace_id=trace_id,
        span_id=server_id,
        attrs={"shape": "otlp-http", "http.route": "/health"},
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        trace_id, parent_span = otel.parse_traceparent(self.headers.get("traceparent", ""))
        if trace_id:
            status_raw = str(args[1]) if len(args) > 1 else "0"
            try:
                status = int(status_raw)
            except ValueError:
                status = 0
            emit_json({
                "method": self.command,
                "path": urlparse(self.path).path,
                "status": status,
                "trace_id": trace_id,
                "span_id": getattr(self, "_local_span", "") or parent_span,
                "shape": "traced",
            })
            return
        log(f"{self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code: int, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        global FAILED_LOOKUPS
        path = urlparse(self.path).path
        if path == "/health":
            maybe_trace_health(self)
            self._json(200, {"status": "ok", "service": NAME})
            return
        if path == "/whoami":
            auth = self.headers.get("Authorization", "")
            if not auth.startswith("Bearer "):
                log(f"{self.address_string()} rejected whoami: missing bearer token", "WARN")
                self._json(401, {"error": "missing bearer token"})
                return
            token = auth.removeprefix("Bearer ").strip()
            user = TOKENS.get(token)
            if user is None:
                FAILED_LOOKUPS += 1
                log(f"{self.address_string()} rejected whoami: unknown or expired token", "WARN")
                if FAILED_LOOKUPS % 5 == 0:
                    log(f"{FAILED_LOOKUPS} rejected token lookups so far — possible stale session storm", "ERROR")
                self._json(401, {"error": "unknown token"})
                return
            self._json(200, {"user": user, "service": NAME})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/login":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            log("received malformed login payload; falling back to defaults", "WARN")
            payload = {}
        user = str(payload.get("user") or "demo@example.com")
        token = f"demo-{user}-{int(time.time())}"
        TOKENS[token] = user
        log(f"issued session token for {user} (active sessions={len(TOKENS)})")
        audit_line("login.success", user, self.address_string(), self.headers.get("User-Agent", "unknown"))
        self._json(200, {"token": token, "user": user})


SYSTEM_CALLERS = ["invoices-api@internal", "invoices-worker@internal", "billing-console@internal"]


def heartbeat() -> None:
    tick = 0
    while True:
        time.sleep(5)
        tick += 1
        log(f"heartbeat active_sessions={len(TOKENS)}")
        if tick % 2 == 0:
            caller = SYSTEM_CALLERS[(tick // 2 - 1) % len(SYSTEM_CALLERS)]
            audit_line("token.refresh", caller, "127.0.0.1", f"devctl-service/{caller.split('@')[0]}")


if __name__ == "__main__":
    threading.Thread(target=heartbeat, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on {PORT}")
    server.serve_forever()
