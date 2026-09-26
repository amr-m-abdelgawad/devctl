#!/usr/bin/env bash
# Installs the pinned OpenTelemetry exporters the otel scenario runs.
# Python packages go to a virtualenv at e2e/.deps/venv (a venv, not
# `pip --target`, so an "externally managed" system Python is fine);
# Node packages go to the fixture's node_modules from its package-lock.json.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .deps/venv
.deps/venv/bin/python -m pip install --quiet --disable-pip-version-check \
  -r fixtures/otel-python/requirements.txt
(cd fixtures/otel-node && npm ci --no-audit --no-fund --loglevel=error)
