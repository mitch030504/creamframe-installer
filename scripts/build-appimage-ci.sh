#!/usr/bin/env bash
# Build a portable AppImage from the deb produced by `tauri build`.
#
# Tauri's built-in AppImage step invokes linuxdeploy's bundled ancient strip,
# which cannot process .relr.dyn sections in current distro libraries. This
# script replaces that strip with the host's newer binutils, then runs the same
# linuxdeploy flow and signs the resulting AppImage.
set -euo pipefail

cd "$(dirname "$0")/.."
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) LD_ARCH=x86_64 ;;
  aarch64) LD_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

REPO_ROOT="$PWD"
VERSION="$(node -p "require('./package.json').version")"
DEB_DIR=src-tauri/target/release/bundle/deb
DEB="$(ls "$DEB_DIR"/*.deb | head -n1)"
OUT_DIR=src-tauri/target/release/bundle/appimage
mkdir -p "$OUT_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/appdir"
(cd "$WORK" && ar x "$REPO_ROOT/$DEB")
tar -xzf "$WORK/data.tar.gz" -C "$WORK/appdir"

DESKTOP="$(find "$WORK/appdir/usr/share/applications" -name '*.desktop' | head -n1)"
ICON="$(find "$WORK/appdir/usr/share/icons/hicolor" -name 'creamframe.png' | sort | tail -n1)"
if [ -z "$DESKTOP" ] || [ -z "$ICON" ]; then
  echo "desktop file or icon missing from deb" >&2
  exit 1
fi

# Extract linuxdeploy so its old bundled strip can be replaced before use.
curl -fsSL -o "$WORK/linuxdeploy.AppImage" \
  "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-${LD_ARCH}.AppImage"
chmod +x "$WORK/linuxdeploy.AppImage"
(cd "$WORK" && APPIMAGE_EXTRACT_AND_RUN=1 ./linuxdeploy.AppImage --appimage-extract >/dev/null)
cp /usr/bin/strip "$WORK/squashfs-root/usr/bin/strip"
chmod +x "$WORK/squashfs-root/usr/bin/strip"
mkdir -p "$WORK/squashfs-root/usr/bin"
curl -fsSL -o "$WORK/squashfs-root/usr/bin/linuxdeploy-plugin-gtk.sh" \
  https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
curl -fsSL -o "$WORK/squashfs-root/usr/bin/linuxdeploy-plugin-gstreamer.sh" \
  https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh
chmod +x "$WORK/squashfs-root/usr/bin/linuxdeploy-plugin-"*.sh

# linuxdeploy scans every ELF in the AppDir; the bundled JDK has internal
# libjvm.so resolution that is not an AppImage dependency. Stage it outside the
# AppDir during dependency deployment, then put it back before packaging.
JDK_REL="usr/lib/CreamFrame/resources/jdk"
if [ -d "$WORK/appdir/$JDK_REL" ]; then
  mv "$WORK/appdir/$JDK_REL" "$WORK/jdk-staged"
fi

export PATH="$WORK/squashfs-root/usr/bin:$PATH"
export DEPLOY_GTK_VERSION=3
"$WORK/squashfs-root/usr/bin/linuxdeploy" \
  --appdir "$WORK/appdir" \
  --executable "$WORK/appdir/usr/bin/creamframe" \
  --desktop-file "$DESKTOP" \
  --icon-file "$ICON" \
  --plugin gtk

if [ -d "$WORK/jdk-staged" ]; then
  mv "$WORK/jdk-staged" "$WORK/appdir/$JDK_REL"
fi

# SteamOS owns the Wayland/XKB/XCB stack; bundling these breaks Gamescope.
for family in libwayland-client libwayland-cursor libwayland-egl libwayland-server \
              libxkbcommon libxcb-randr libxcb-render libxcb-shm libXau libXdmcp; do
  find "$WORK/appdir/usr/lib" -maxdepth 1 -name "${family}.so*" -delete 2>/dev/null || true
done

# linuxdeploy may not have created AppRun when the appimage output plugin is
# skipped. A symlink to the binary is sufficient for our single-binary app.
if [ ! -e "$WORK/appdir/AppRun" ]; then
  ln -s usr/bin/creamframe "$WORK/appdir/AppRun"
fi

curl -fsSL -o "$WORK/appimagetool.AppImage" \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${LD_ARCH}.AppImage"
chmod +x "$WORK/appimagetool.AppImage"
TARGET="$REPO_ROOT/$OUT_DIR/CreamFrame_${VERSION}_${ARCH}.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 "$WORK/appimagetool.AppImage" "$WORK/appdir" "$TARGET"
chmod +x "$TARGET"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  npx --prefix "$PWD" tauri signer sign "$TARGET"
fi
echo "built $TARGET"
