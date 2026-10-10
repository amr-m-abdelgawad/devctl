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

# The log and watchdog workers are extra entrypoints, so each binary embeds
# them. `[name].[ext]` puts them at `$bunfs/root/<worker>.js`, beside the
# entrypoint, which is the same layout as the npm package's dist/ and where
# resolveWorkerUrl looks.
WORKERS=(src/adapters/storage/log-worker.ts src/adapters/daemon/event-loop-watchdog-worker.ts)

compile() {
  local target="$1"
  local out="$2"
  local args=(build --compile --target="$target" --entry-naming "[name].[ext]" --define "process.env.DEVCTL_VERSION=\"${VERSION}\"")
  case "$target" in
    bun-linux-*) args+=(--define "process.env.OPENTUI_LIBC=\"glibc\"") ;;
  esac
  echo "compile ${target} -> ${OUTDIR}/${out}"
  bun "${args[@]}" --outfile "${OUTDIR}/${out}" src/bin.ts "${WORKERS[@]}"
}

compile bun-darwin-arm64 devctl-darwin-arm64
compile bun-darwin-x64 devctl-darwin-x64
compile bun-linux-x64 devctl-linux-x64
compile bun-linux-arm64 devctl-linux-arm64
compile bun-windows-x64 devctl-windows-x64.exe
