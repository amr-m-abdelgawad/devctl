#!/usr/bin/env python3
"""Identity service — session login, token issuance, whoami. stdlib only."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "identity")
PORT = int(os.environ.get("SERVICE_PORT") or os.environ.get("HTTP_PORT") or "18001")
TOKENS: dict[str, str] = {}
FAILED_LOOKUPS = 0


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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
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
