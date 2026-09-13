#!/usr/bin/env bash
# Rebuild canary-desktop .deb from this source tree, reusing Electron binaries
# from an existing package (default: sibling 0.1.1 deb).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${OUT_DIR:-$(dirname "$ROOT")}"
VERSION="$(python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])")"
BASE_DEB="${BASE_DEB:-$OUT_DIR/canary-desktop_0.1.1_amd64.deb}"
if [[ ! -f "$BASE_DEB" ]]; then
  BASE_DEB="$OUT_DIR/canary-desktop_0.1.0_amd64.deb"
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Base: $BASE_DEB"
echo "Version: $VERSION"
cd "$WORK"
ar x "$BASE_DEB"
mkdir data
tar -xJf data.tar.xz -C data
tar -xJf control.tar.xz

# App source → asar
mkdir -p "$WORK/asar-src"
cp "$ROOT/package.json" "$WORK/asar-src/"
cp -a "$ROOT/src" "$WORK/asar-src/"
npx --yes asar pack "$WORK/asar-src" data/opt/Canary/resources/app.asar

# Electron window + tray icons (square badge logo)
cp "$ROOT/assets/icon.png" data/opt/Canary/resources/icon.png
cp "$ROOT/assets/tray-icon.png" data/opt/Canary/resources/tray-icon.png
cp "$ROOT/assets/tray-icon@2x.png" data/opt/Canary/resources/tray-icon@2x.png
cp "$ROOT/assets/tray-icon-128.png" data/opt/Canary/resources/tray-icon-128.png

# Desktop entry + hicolor icons
cp "$ROOT/packaging/canary.desktop" data/usr/share/applications/canary.desktop
rm -rf data/usr/share/icons/hicolor
mkdir -p data/usr/share/icons
cp -a "$ROOT/packaging/icons/hicolor" data/usr/share/icons/

# Control scripts + version
cp "$ROOT/packaging/postinst" ./postinst
cp "$ROOT/packaging/postrm" ./postrm
chmod 0755 postinst postrm
sed -i "s/^Version:.*/Version: $VERSION/" control
# Installed-Size in KiB
SIZE_KB="$(du -sk data | awk '{print $1}')"
sed -i "s/^Installed-Size:.*/Installed-Size: $SIZE_KB/" control

(
  cd data
  find . -type f -printf '%P\n' | sort | while read -r f; do
    md5sum "$f"
  done
) > md5sums

tar --owner=0 --group=0 -cJf control.tar.xz control md5sums postinst postrm
tar --owner=0 --group=0 -C data -cJf data.tar.xz .

OUT="$OUT_DIR/canary-desktop_${VERSION}_amd64.deb"
rm -f "$OUT"
ar r "$OUT" debian-binary control.tar.xz data.tar.xz
echo "Wrote $OUT"
ls -lh "$OUT"
