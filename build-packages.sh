#!/usr/bin/env bash
# Build canary-desktop .deb (Debian/Ubuntu) and .rpm (Fedora x86_64) via nfpm.
#
# Reuses Electron binaries from an existing .deb (BASE_DEB), packs current app
# source into app.asar, then emits:
#   - deb: /opt/Canary (unchanged layout)
#   - rpm: /usr/lib64/canary + /usr/bin/canary (Workstation + Atomic-friendly)
#
# Usage:
#   ./build-packages.sh              # both formats
#   ./build-packages.sh deb          # .deb only
#   ./build-packages.sh rpm          # .rpm only
#
# Env:
#   BASE_DEB   path to a canary-desktop_*.deb that already contains Electron
#   OUT_DIR    output directory (default: ./dist)
#   NFPM       path to nfpm binary (default: .tools/nfpm or nfpm on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
VERSION="$(python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])")"
TARGETS="${1:-all}"

NFPM="${NFPM:-}"
if [[ -z "$NFPM" ]]; then
  if [[ -x "$ROOT/.tools/nfpm" ]]; then
    NFPM="$ROOT/.tools/nfpm"
  elif command -v nfpm >/dev/null 2>&1; then
    NFPM="$(command -v nfpm)"
  else
    echo "nfpm not found. Install: https://nfpm.goreleaser.com/install/" >&2
    echo "Or place a binary at $ROOT/.tools/nfpm" >&2
    exit 1
  fi
fi

BASE_DEB="${BASE_DEB:-}"
if [[ -z "$BASE_DEB" ]]; then
  for candidate in \
    "$OUT_DIR/electron-base-${VERSION}_amd64.deb" \
    "$OUT_DIR/electron-base-0.1.5_amd64.deb" \
    "$OUT_DIR/canary-desktop_${VERSION}_amd64.deb" \
    "$OUT_DIR/canary-desktop_0.1.5_amd64.deb" \
    "$ROOT/../canary-desktop_${VERSION}_amd64.deb" \
    "$ROOT/../canary-desktop_0.1.5_amd64.deb" \
    "$ROOT/../canary-desktop_0.1.1_amd64.deb" \
    "$ROOT/../canary-desktop_0.1.0_amd64.deb"
  do
    if [[ -f "$candidate" ]]; then
      BASE_DEB="$candidate"
      break
    fi
  done
fi
if [[ -z "${BASE_DEB:-}" || ! -f "$BASE_DEB" ]]; then
  echo "Set BASE_DEB to a canary-desktop_*.deb that contains Electron binaries." >&2
  exit 1
fi
BASE_DEB="$(cd "$(dirname "$BASE_DEB")" && pwd)/$(basename "$BASE_DEB")"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need_cmd python3
need_cmd npx
need_cmd ar
need_cmd tar
need_cmd rsync

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Base:    $BASE_DEB"
echo "Version: $VERSION"
echo "nfpm:    $NFPM"
echo "Targets: $TARGETS"

# Extract Electron payload from base .deb
mkdir -p "$WORK/base"
(
  cd "$WORK/base"
  ar x "$BASE_DEB"
  mkdir data
  tar -xJf data.tar.xz -C data
)
ELECTRON_SRC="$WORK/base/data/opt/Canary"
if [[ ! -x "$ELECTRON_SRC/canary" ]]; then
  echo "Base package missing /opt/Canary/canary" >&2
  exit 1
fi

# Pack app source → asar
mkdir -p "$WORK/asar-src"
cp "$ROOT/package.json" "$WORK/asar-src/"
cp -a "$ROOT/src" "$WORK/asar-src/"
npx --yes asar pack "$WORK/asar-src" "$WORK/app.asar"

stage_common_icons() {
  local dest_share="$1"
  mkdir -p "$dest_share/icons"
  # Break hardlinks between icon sizes — nfpm rejects duplicate inodes at different paths.
  rsync -a --copy-links "$ROOT/packaging/icons/hicolor/" "$dest_share/icons/hicolor/"
}

stage_electron_tree() {
  local dest="$1"
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude 'resources/app.asar' \
    --exclude 'resources/icon.png' \
    --exclude 'resources/tray-icon.png' \
    --exclude 'resources/tray-icon@2x.png' \
    --exclude 'resources/tray-icon-128.png' \
    "$ELECTRON_SRC/" "$dest/"
  mkdir -p "$dest/resources"
  cp "$WORK/app.asar" "$dest/resources/app.asar"
  cp "$ROOT/assets/icon.png" "$dest/resources/icon.png"
  cp "$ROOT/assets/tray-icon.png" "$dest/resources/tray-icon.png"
  cp "$ROOT/assets/tray-icon@2x.png" "$dest/resources/tray-icon@2x.png"
  cp "$ROOT/assets/tray-icon-128.png" "$dest/resources/tray-icon-128.png"
  chmod 0755 "$dest/canary"
}

build_deb() {
  local stage="$WORK/stage-deb"
  rm -rf "$stage"
  mkdir -p "$stage/opt" "$stage/usr/share/applications"
  stage_electron_tree "$stage/opt/Canary"
  stage_common_icons "$stage/usr/share"
  cp "$ROOT/packaging/canary.desktop" "$stage/usr/share/applications/canary.desktop"

  local scripts="$WORK/scripts-deb"
  mkdir -p "$scripts"
  cp "$ROOT/packaging/postinst" "$scripts/postinst"
  cp "$ROOT/packaging/postrm" "$scripts/postrm"
  chmod 0755 "$scripts/postinst" "$scripts/postrm"

  local cfg="$WORK/nfpm-deb.yaml"
  VERSION="$VERSION" ARCH=amd64 STAGE="$stage" SCRIPTS="$scripts" \
    envsubst '${VERSION} ${ARCH} ${STAGE} ${SCRIPTS}' \
    < "$ROOT/packaging/nfpm.yaml" > "$cfg"

  mkdir -p "$OUT_DIR"
  (
    cd "$WORK"
    "$NFPM" package -f "$cfg" -p deb -t "$OUT_DIR"
  )
  local out
  out="$(ls -1t "$OUT_DIR"/canary-desktop_*_amd64.deb 2>/dev/null | head -1)"
  echo "Wrote $out"
  ls -lh "$out"
}

build_rpm() {
  local stage="$WORK/stage-rpm"
  rm -rf "$stage"
  mkdir -p "$stage/usr/lib64" "$stage/usr/bin" "$stage/usr/share/applications"
  stage_electron_tree "$stage/usr/lib64/canary"
  stage_common_icons "$stage/usr/share"
  cp "$ROOT/packaging/canary-rpm.desktop" "$stage/usr/share/applications/canary.desktop"
  ln -sfn ../lib64/canary/canary "$stage/usr/bin/canary"

  local scripts="$WORK/scripts-rpm"
  mkdir -p "$scripts"
  cp "$ROOT/packaging/rpm-postinst" "$scripts/postinst"
  cp "$ROOT/packaging/rpm-postrm" "$scripts/postrm"
  chmod 0755 "$scripts/postinst" "$scripts/postrm"

  local cfg="$WORK/nfpm-rpm.yaml"
  VERSION="$VERSION" ARCH=amd64 STAGE="$stage" SCRIPTS="$scripts" \
    envsubst '${VERSION} ${ARCH} ${STAGE} ${SCRIPTS}' \
    < "$ROOT/packaging/nfpm.yaml" > "$cfg"
  # nfpm maps arch amd64 → x86_64 for rpm automatically when arch is amd64

  mkdir -p "$OUT_DIR"
  (
    cd "$WORK"
    "$NFPM" package -f "$cfg" -p rpm -t "$OUT_DIR"
  )
  local out
  out="$(ls -1t "$OUT_DIR"/canary-desktop-*.x86_64.rpm 2>/dev/null | head -1 || ls -1t "$OUT_DIR"/canary-desktop-*.rpm 2>/dev/null | head -1)"
  echo "Wrote $out"
  ls -lh "$out"
}

case "$TARGETS" in
  all)
    build_deb
    build_rpm
    ;;
  deb) build_deb ;;
  rpm) build_rpm ;;
  *)
    echo "Usage: $0 [all|deb|rpm]" >&2
    exit 1
    ;;
esac

echo "Done. Packages in $OUT_DIR"
