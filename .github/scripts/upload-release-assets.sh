#!/usr/bin/env bash
set -euo pipefail

# Upload GitHub Release assets one file at a time with retries.
#
# gh release upload defaults to 5 concurrent workers. Several ~90MB binaries
# hitting uploads.github.com at once is a known source of
# `HTTP 500: Error saving asset`, which aborts the errgroup and leaves a
# partial draft. Sequential uploads plus backoff recover from that without
# moving the tag.
#
# Usage:
#   bash .github/scripts/upload-release-assets.sh v0.13.1 dist/devctl-linux-x64 ...

TAG="${1:?usage: upload-release-assets.sh <tag> <file> [file...]}"
shift
if [ "$#" -eq 0 ]; then
  echo "usage: upload-release-assets.sh <tag> <file> [file...]" >&2
  exit 2
fi

MAX_ATTEMPTS="${UPLOAD_ATTEMPTS:-5}"
DELAY_SECONDS="${UPLOAD_RETRY_DELAY_SECONDS:-5}"
if ! [[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "UPLOAD_ATTEMPTS must be a positive integer (got ${UPLOAD_ATTEMPTS-unset})" >&2
  exit 2
fi
if ! [[ "$DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "UPLOAD_RETRY_DELAY_SECONDS must be a non-negative integer (got ${UPLOAD_RETRY_DELAY_SECONDS-unset})" >&2
  exit 2
fi

upload_one() {
  local file="$1"
  local name
  local attempt=1
  local delay="$DELAY_SECONDS"

  name="$(basename "$file")"
  if [ ! -f "$file" ]; then
    echo "Release asset not found: $file" >&2
    return 1
  fi

  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    echo "Uploading $name (attempt $attempt/$MAX_ATTEMPTS)"
    if gh release upload "$TAG" "$file" --clobber; then
      echo "Uploaded $name"
      return 0
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "Failed to upload $name after $MAX_ATTEMPTS attempts" >&2
      return 1
    fi
    echo "Upload of $name failed (attempt $attempt/$MAX_ATTEMPTS); retrying in ${delay}s..." >&2
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

for file in "$@"; do
  upload_one "$file"
done
