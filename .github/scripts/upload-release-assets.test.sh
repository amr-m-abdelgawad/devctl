#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/upload-release-assets.sh"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$STAGING/bin" "$STAGING/dist"
: >"$STAGING/linux-x64"
: >"$STAGING/darwin-x64"
cp "$STAGING/linux-x64" "$STAGING/dist/devctl-linux-x64"
cp "$STAGING/darwin-x64" "$STAGING/dist/devctl-darwin-x64"

write_mock_gh() {
  local remaining="$1"
  printf '%s\n' "$remaining" >"$STAGING/fail-remaining"
  : >"$STAGING/gh-log"
  cat >"$STAGING/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${GH_LOG:?}"
remaining="$(cat "${FAIL_REMAINING_FILE:?}")"
if [ "$remaining" -gt 0 ]; then
  echo $((remaining - 1)) >"$FAIL_REMAINING_FILE"
  echo "HTTP 500: Error saving asset (https://uploads.github.com/example?name=asset)" >&2
  exit 1
fi
exit 0
EOF
  chmod +x "$STAGING/bin/gh"
}

run_upload() {
  env PATH="$STAGING/bin:$PATH" \
    GH_LOG="$STAGING/gh-log" \
    FAIL_REMAINING_FILE="$STAGING/fail-remaining" \
    UPLOAD_ATTEMPTS="${UPLOAD_ATTEMPTS:-5}" \
    UPLOAD_RETRY_DELAY_SECONDS=0 \
    bash "$SCRIPT" "$@"
}

write_mock_gh 2
run_upload v0.13.1 "$STAGING/dist/devctl-linux-x64"
attempts="$(grep -c 'release upload v0.13.1' "$STAGING/gh-log")"
if [ "$attempts" -ne 3 ]; then
  echo "expected 3 upload attempts after two 500s, got $attempts" >&2
  exit 1
fi

write_mock_gh 0
run_upload v0.13.1 "$STAGING/dist/devctl-linux-x64" "$STAGING/dist/devctl-darwin-x64"
mapfile -t uploaded <"$STAGING/gh-log"
if [ "${#uploaded[@]}" -ne 2 ]; then
  echo "expected one gh invocation per file, got ${#uploaded[@]}" >&2
  exit 1
fi
if [[ "${uploaded[0]}" != *devctl-linux-x64* || "${uploaded[1]}" != *devctl-darwin-x64* ]]; then
  echo "expected sequential linux-x64 then darwin-x64 uploads" >&2
  printf '%s\n' "${uploaded[@]}" >&2
  exit 1
fi

write_mock_gh 5
if UPLOAD_ATTEMPTS=3 run_upload v0.13.1 "$STAGING/dist/devctl-linux-x64"; then
  echo "expected exhaustion of retries to fail" >&2
  exit 1
fi
attempts="$(grep -c 'release upload v0.13.1' "$STAGING/gh-log")"
if [ "$attempts" -ne 3 ]; then
  echo "expected exactly 3 attempts before giving up, got $attempts" >&2
  exit 1
fi

if run_upload v0.13.1 "$STAGING/dist/missing-binary" 2>/dev/null; then
  echo "expected missing asset to fail" >&2
  exit 1
fi

echo "upload-release-assets.sh ok"
