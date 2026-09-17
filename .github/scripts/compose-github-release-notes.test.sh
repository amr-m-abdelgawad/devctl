#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/compose-github-release-notes.cjs"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

notes="$(node "$SCRIPT" 0.13.1 "$ROOT/CHANGELOG.md")"
printf '%s\n' "$notes" >"$STAGING/notes.md"

assert_contains() {
  local needle="$1"
  if ! grep -F -q -- "$needle" "$STAGING/notes.md"; then
    echo "expected notes to contain: $needle" >&2
    cat "$STAGING/notes.md" >&2
    exit 1
  fi
}

assert_missing() {
  local needle="$1"
  if grep -F -q -- "$needle" "$STAGING/notes.md"; then
    echo "expected notes not to contain: $needle" >&2
    exit 1
  fi
}

assert_contains "**Local hardening: plugins cannot load from outside the repo, recipes cannot hit cloud-metadata hosts, the web console requires its bearer token, and daemon memory buffers are capped.**"
assert_contains "## Fixed"
assert_contains "inside the repository root"
assert_contains "## Upgrading"
assert_contains "so the attached daemon is 0.13.1"
assert_contains "Trust notice:"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/compare/v0.13.0...v0.13.1"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/blob/v0.13.1/docs/plugins.md"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/blob/v0.13.1/docs/http.md"
assert_missing "chore: bump version"
assert_missing "What's Changed"
assert_missing "HTTP 500: Error saving asset"
assert_missing "## Unreleased"

if node "$SCRIPT" 9.9.9 "$ROOT/CHANGELOG.md" >/dev/null 2>"$STAGING/err"; then
  echo "expected a missing version to fail" >&2
  exit 1
fi
if ! grep -q '9.9.9' "$STAGING/err"; then
  echo "expected the missing-version error to name the version" >&2
  cat "$STAGING/err" >&2
  exit 1
fi

echo "compose-github-release-notes.cjs ok"
