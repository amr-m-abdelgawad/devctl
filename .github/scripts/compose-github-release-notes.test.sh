#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/compose-github-release-notes.cjs"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

# Fixture, not the live CHANGELOG.md: Unreleased may mention an upload 500
# that a released section must not leak into GitHub notes.
cat >"$STAGING/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

### Fixed

- Release publishing retries a transient `HTTP 500: Error saving asset`.

## [1.2.3] - 2026-01-02

Local hardening: plugins stay inside the repo.

See [Plugins](docs/plugins.md) and [HTTP recipes](docs/http.md).

### Fixed

- Config plugins must resolve **inside the repository root**.

## [1.2.2] - 2026-01-01

### Added

- Example prior release.
EOF

notes="$(node "$SCRIPT" 1.2.3 "$STAGING/CHANGELOG.md")"
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
    cat "$STAGING/notes.md" >&2
    exit 1
  fi
}

assert_contains "**Local hardening: plugins stay inside the repo.**"
assert_contains "## Fixed"
assert_contains "inside the repository root"
assert_contains "## Upgrading"
assert_contains "so the attached daemon is 1.2.3"
assert_contains "Trust notice:"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/compare/v1.2.2...v1.2.3"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/blob/v1.2.3/docs/plugins.md"
assert_contains "https://github.com/amr-m-abdelgawad/devctl/blob/v1.2.3/docs/http.md"
assert_missing "chore: bump version"
assert_missing "What's Changed"
assert_missing "HTTP 500: Error saving asset"
assert_missing "## Unreleased"
assert_missing "Example prior release"

if node "$SCRIPT" 9.9.9 "$STAGING/CHANGELOG.md" >/dev/null 2>"$STAGING/err"; then
  echo "expected a missing version to fail" >&2
  exit 1
fi
if ! grep -q '9.9.9' "$STAGING/err"; then
  echo "expected the missing-version error to name the version" >&2
  cat "$STAGING/err" >&2
  exit 1
fi

echo "compose-github-release-notes.cjs ok"
