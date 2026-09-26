#!/usr/bin/env python3
"""OpenAI-compatible LLM stub — no LiteLLM, no cloud, stdlib only.

Serves /v1/chat/completions (JSON and SSE), /v1/embeddings, and a proprietary
/generations/v1alpha2 path so the demo's proxy-capture LLM source and traffic
inspector have something local to record.
"""

from __future__ import annotations

import json
import os
import sys
import time
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

NAME = os.environ.get("DEVCTL_SERVICE_NAME", "llm")
PORT = int(os.environ.get("SERVICE_PORT") or os.environ.get("HTTP_PORT") or "18005")
MODEL = "demo-stub"


def log(message: str, level: str = "INFO") -> None:
    sys.stdout.write(f"{level} {NAME} {message}\n")
    sys.stdout.flush()


def last_user_text(payload: dict[str, object]) -> str:
    messages = payload.get("messages")
    if isinstance(messages, list):
        for item in reversed(messages):
            if not isinstance(item, dict):
                continue
            if str(item.get("role") or "") != "user":
                continue
            content = item.get("content")
            if isinstance(content, str) and content.strip() != "":
                return content.strip()
    prompt = payload.get("prompt")
    if isinstance(prompt, str) and prompt.strip() != "":
        return prompt.strip()
    return "invoice"


def reply_for(prompt: str) -> str:
    return (
        f"[demo-stub] Draft for {prompt[:80]}: the invoice is queued, "
        "identity confirmed the session, and the worker will finalize the PDF."
    )


def usage_for(prompt: str, reply: str) -> dict[str, int]:
    prompt_tokens = max(1, len(prompt.split()))
    completion_tokens = max(1, len(reply.split()))
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }


def chat_completion(payload: dict[str, object], reply: str, usage: dict[str, int]) -> dict[str, object]:
    created = int(time.time())
    return {
        "id": f"chatcmpl-demo-{created}",
        "object": "chat.completion",
        "created": created,
        "model": str(payload.get("model") or MODEL),
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": reply},
            "finish_reason": "stop",
        }],
        "usage": usage,
    }


def sse_chunks(payload: dict[str, object], reply: str, usage: dict[str, int]) -> list[dict[str, object]]:
    created = int(time.time())
    model = str(payload.get("model") or MODEL)
    cid = f"chatcmpl-demo-{created}"
    words = reply.split()
    chunks: list[dict[str, object]] = [{
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}],
    }]
    for word in words:
        chunks.append({
            "id": cid,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}],
        })
    chunks.append({
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        "usage": usage,
    })
    return chunks


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def _json(self, code: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}
        return payload if isinstance(payload, dict) else {}

    def _sse(self, chunks: list[dict[str, object]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"status": "ok", "service": NAME, "model": MODEL})
            return
        if path in ("/v1/models", "/models"):
            self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "devctl-demo"}]})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        payload = self._read_json()
        prompt = last_user_text(payload)
        reply = reply_for(prompt)
        usage = usage_for(prompt, reply)
        model = str(payload.get("model") or MODEL)
        if path in ("/v1/chat/completions", "/chat/completions", "/v1/completions", "/completions"):
            if payload.get("stream") is True:
                log(f"stream chat model={model} prompt={prompt[:48]!r}")
                self._sse(sse_chunks(payload, reply, usage))
                return
            log(f"chat model={model} prompt={prompt[:48]!r}")
            self._json(200, chat_completion(payload, reply, usage))
            return
        if path in ("/v1/embeddings", "/embeddings"):
            log(f"embeddings model={model}")
            self._json(200, {
                "object": "list",
                "model": model,
                "data": [{"object": "embedding", "index": 0, "embedding": [0.01, 0.02, 0.03]}],
                "usage": {"prompt_tokens": usage["prompt_tokens"], "total_tokens": usage["prompt_tokens"]},
            })
            return
        if path == "/generations/v1alpha2":
            log(f"proprietary generation model={model} prompt={prompt[:48]!r}")
            self._json(200, {
                "model": model,
                "text": reply,
                "finish_reason": "stop",
                "usage": {
                    "prompt_tokens": usage["prompt_tokens"],
                    "completion_tokens": usage["completion_tokens"],
                    "total_tokens": usage["total_tokens"],
                },
            })
            return
        self._json(404, {"error": "not found"})


class LoopbackHTTPServer(ThreadingHTTPServer):
    """Skips HTTPServer.server_bind's socket.getfqdn(), which can stall on macOS
    before the server accepts connections (see traceutil.LoopbackHTTPServer)."""

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


if __name__ == "__main__":
    server = LoopbackHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on {PORT} model={MODEL}")
    server.serve_forever()
