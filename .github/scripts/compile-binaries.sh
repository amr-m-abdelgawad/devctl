#!/usr/bin/env bash
set -euo pipefail

# Cross-compile standalone binaries for GitHub Releases.
# OpenTUI optional native packages for every OS/CPU must already be installed:
#   bun install --frozen-lockfile --os="*" --cpu="*"
#
# Usage (from app/):
#   DEVCTL_VERSION=0.1.4 OUTDIR=../dist bash ../.github/scripts/compile-binaries.sh

VERSION="${DEVCTL_VERSION:?DEVCTL_VERSION is required}"
OUTDIR="${OUTDIR:-../dist}"
mkdir -p "$OUTDIR"

compile() {
  local target="$1"
  local out="$2"
  local args=(build --compile --target="$target" --define "process.env.DEVCTL_VERSION=\"${VERSION}\"")
  case "$target" in
    bun-linux-*) args+=(--define "process.env.OPENTUI_LIBC=\"glibc\"") ;;
  esac
  echo "compile ${target} -> ${OUTDIR}/${out}"
  bun "${args[@]}" --outfile "${OUTDIR}/${out}" src/bin.ts
}

compile bun-darwin-arm64 devctl-darwin-arm64
compile bun-darwin-x64 devctl-darwin-x64
compile bun-linux-x64 devctl-linux-x64
compile bun-linux-arm64 devctl-linux-arm64
compile bun-windows-x64 devctl-windows-x64.exe
