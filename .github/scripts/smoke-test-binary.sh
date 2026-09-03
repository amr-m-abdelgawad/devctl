#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke test for a compiled `devctl` binary: start a real
# supervisor from it, confirm a service comes up, then tear it down again.
# This exists because a compiled executable's argv shape differs from
# `bun run src/bin.ts` — ensureSupervisor() spawning the wrong command line
# for the daemon it tries to launch is invisible to `bun test` (which only
# ever runs from source) and only shows up against a real compiled binary.
#
# Usage: smoke-test-binary.sh /path/to/devctl-binary

BINARY="${1:?usage: smoke-test-binary.sh /path/to/devctl-binary}"
BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"

WORKDIR="$(mktemp -d)"
export DEVCTL_HOME="$WORKDIR/home"
CONFIG="$WORKDIR/.devctl/config.yaml"
SUPERVISOR_PID=""

# Preserves the script's real exit status: a cleanup problem must not turn a
# passing smoke test into a red build, and must not mask a failing one either.
cleanup() {
  status=$?
  # Ask the daemon to stop and wait for it to actually go, rather than
  # SIGTERM-and-immediately-rm. Its shutdown persists state and flushes log
  # writes asynchronously, so removing the tree underneath it raced and failed
  # with "Directory not empty" once the daemon wrote one more file than the
  # walk had already listed.
  "$BINARY" --config "$CONFIG" down >/dev/null 2>&1 || true
  if [ -n "$SUPERVISOR_PID" ]; then
    waited=0
    while kill -0 "$SUPERVISOR_PID" 2>/dev/null && [ "$waited" -lt 50 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    kill "$SUPERVISOR_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$WORKDIR/.devctl"
cat > "$CONFIG" <<'YAML'
version: 1
project:
  name: smoke-test
services:
  ping:
    command: ["sleep", "300"]
YAML

echo "== devctl start --detach (compiled binary) =="
"$BINARY" --config "$CONFIG" start ping --detach

echo "== devctl status =="
STATUS_OUTPUT="$("$BINARY" --config "$CONFIG" status)"
echo "$STATUS_OUTPUT"
echo "$STATUS_OUTPUT" | grep -Eq 'ping[[:space:]]+(RUNNING|HEALTHY)' || {
  echo "FAIL: service 'ping' is not RUNNING/HEALTHY in status output" >&2
  exit 1
}

LOCK_FILE="$(find "$DEVCTL_HOME" -name devctl.lock 2>/dev/null | head -1)"
if [ -z "$LOCK_FILE" ]; then
  echo "FAIL: no devctl.lock found under $DEVCTL_HOME — supervisor never started" >&2
  exit 1
fi
SUPERVISOR_PID="$(grep -oE '"pid":[0-9]+' "$LOCK_FILE" | head -1 | grep -oE '[0-9]+')"
if [ -z "$SUPERVISOR_PID" ] || ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
  echo "FAIL: supervisor pid from lock file ($SUPERVISOR_PID) is not a live process" >&2
  exit 1
fi
echo "supervisor pid $SUPERVISOR_PID is alive"

echo "== devctl stop =="
"$BINARY" --config "$CONFIG" stop
STOPPED_OUTPUT="$("$BINARY" --config "$CONFIG" status)"
echo "$STOPPED_OUTPUT"
echo "$STOPPED_OUTPUT" | grep -Eq 'ping[[:space:]]+STOPPED' || {
  echo "FAIL: service 'ping' did not report STOPPED after devctl stop" >&2
  exit 1
}

echo "== devctl down =="
"$BINARY" --config "$CONFIG" down
# Assert what down actually promises: the daemon no longer serves this
# repository. Deliberately NOT "the pid is gone" — shutdown() closes the
# socket and releases the lock but does not call process.exit(), so the
# process can linger for a few seconds after it has stopped answering. A
# fresh daemon can already take the lock at that point, which is what
# matters; asserting on the pid would fail for a daemon behaving correctly.
DOWN_OUTPUT="$("$BINARY" --config "$CONFIG" status)"
echo "$DOWN_OUTPUT"
echo "$DOWN_OUTPUT" | grep -q 'supervisor is not running' || {
  echo "FAIL: supervisor still answering after devctl down" >&2
  exit 1
}
echo "supervisor stopped serving"

echo "compiled-binary supervisor smoke test passed"
