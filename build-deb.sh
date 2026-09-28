#!/usr/bin/env bash
# Legacy entry point — prefer ./build-packages.sh
# Rebuilds the .deb only (same Electron-base workflow).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/build-packages.sh" deb
