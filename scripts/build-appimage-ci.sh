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
if ls "$DEB_DIR"/CreamFrame_"${VERSION}"_*.deb >/dev/null 2>&1; then
  DEB="$(ls -t "$DEB_DIR"/CreamFrame_"${VERSION}"_*.deb | head -n1)"
else
  DEB="$(ls -t "$DEB_DIR"/*.deb | head -n1)"
fi
OUT_DIR=src-tauri/target/release/bundle/appimage
mkdir -p "$OUT_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/appdir"
(cd "$WORK" && ar x "$REPO_ROOT/$DEB")
tar -xzf "$WORK/data.tar.gz" -C "$WORK/appdir"

# The binary in the deb declares the deb bundle type, so Tauri's updater would
# invoke dpkg instead of replacing the AppImage. Use the binary patched by
# `tauri build --bundles appimage`, which declares the AppImage bundle type.
APPIMAGE_BIN="$REPO_ROOT/src-tauri/target/release/creamframe"
if [ -f "$APPIMAGE_BIN" ]; then
  if ! grep -aq '__TAURI_BUNDLE_TYPE_VAR_APP' "$APPIMAGE_BIN"; then
    echo "error: $APPIMAGE_BIN is not patched for the AppImage bundle type" >&2
    echo "run: NO_STRIP=true npm run tauri build -- --bundles appimage" >&2
    exit 1
  fi
  cp "$APPIMAGE_BIN" "$WORK/appdir/usr/bin/creamframe"
  chmod +x "$WORK/appdir/usr/bin/creamframe"
fi

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
# Some distros keep nested app-local copies of GTK libraries under /usr/lib.
# Only deploy the top-level ones, or linuxdeploy pulls in incompatible copies.
sed -i 's|find "\$directory" \\(|find "\$directory" -maxdepth 1 \\(|' \
  "$WORK/squashfs-root/usr/bin/linuxdeploy-plugin-gtk.sh"

# linuxdeploy scans every ELF in the AppDir; the bundled JDK has internal
# libjvm.so resolution that is not an AppImage dependency. Stage it outside the
# AppDir during dependency deployment, then put it back before packaging.
JDK_REL="usr/lib/CreamFrame/resources/jdk"
ANDROID_REL="usr/lib/CreamFrame/resources/android"
if [ -d "$WORK/appdir/$JDK_REL" ]; then
  mv "$WORK/appdir/$JDK_REL" "$WORK/jdk-staged"
fi
# The Android proxy is a bionic ELF; linuxdeploy's host ldd cannot inspect it.
if [ -d "$WORK/appdir/$ANDROID_REL" ]; then
  mv "$WORK/appdir/$ANDROID_REL" "$WORK/android-staged"
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
if [ -d "$WORK/android-staged" ]; then
  mv "$WORK/android-staged" "$WORK/appdir/$ANDROID_REL"
fi

# WebKitGTK launches helper processes from a private directory. The bundled
# libwebkit2gtk resolves that directory relative to the current working
# directory ("././lib/<triplet>/webkit2gtk-4.1"), so package the helpers there
# and make AppRun cd into the AppDir before exec. The helpers also need the
# bundled ICU via LD_LIBRARY_PATH. The exact relative directory depends on the
# distro's WebKit build, so read it from the library itself.
case "$LD_ARCH" in
  x86_64) TRIPLET=x86_64-linux-gnu ;;
  aarch64) TRIPLET=aarch64-linux-gnu ;;
esac
WEBKIT_LIB="$(find "$WORK/appdir/usr/lib" -maxdepth 1 -name 'libwebkit2gtk-4.1.so.0' | head -n1)"
WEBKIT_REL=""
if [ -n "$WEBKIT_LIB" ]; then
  WEBKIT_REL="$(strings "$WEBKIT_LIB" \
    | grep -E '^\./\./+lib/.*webkit2gtk-4\.1$' | head -n1 \
    | sed -e 's|^\./||' -e 's|^\./||' -e 's|^/||' -e 's|//*|/|g')"
fi
if [ -n "$WEBKIT_REL" ] && [ -d "/$WEBKIT_REL" ]; then
  mkdir -p "$WORK/appdir/$(dirname "$WEBKIT_REL")"
  cp -a "/$WEBKIT_REL" "$WORK/appdir/$(dirname "$WEBKIT_REL")/"
fi

# SteamOS owns the Wayland/XKB/XCB stack; bundling these breaks Gamescope.
for family in libwayland-client libwayland-cursor libwayland-egl libwayland-server \
              libxkbcommon libxcb-randr libxcb-render libxcb-shm libXau libXdmcp; do
  find "$WORK/appdir/usr/lib" -maxdepth 1 -name "${family}.so*" -delete 2>/dev/null || true
done

# linuxdeploy may not have created AppRun when the appimage output plugin is
# skipped. Keep its AppRun.wrapped target, but replace the generated AppRun
# with one that sets the library path and working directory WebKit needs.
if [ ! -e "$WORK/appdir/AppRun.wrapped" ]; then
  ln -s usr/bin/creamframe "$WORK/appdir/AppRun.wrapped"
fi
cat > "$WORK/appdir/AppRun" <<APPRUN
#!/usr/bin/env bash
set -e
this_dir="\$(readlink -f "\$(dirname "\$0")")"
export APPDIR="\${APPDIR:-\$this_dir}"
if [ -f "\$this_dir/apprun-hooks/linuxdeploy-plugin-gtk.sh" ]; then
  source "\$this_dir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
fi
cd "\$APPDIR"
export LD_LIBRARY_PATH="\$APPDIR/usr/lib:\$APPDIR/usr/lib/${TRIPLET}:\${LD_LIBRARY_PATH:-}"
exec "\$this_dir/AppRun.wrapped" "\$@"
APPRUN
chmod +x "$WORK/appdir/AppRun"

curl -fsSL -o "$WORK/appimagetool.AppImage" \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${LD_ARCH}.AppImage"
chmod +x "$WORK/appimagetool.AppImage"
TARGET="$REPO_ROOT/$OUT_DIR/CreamFrame_${VERSION}_${ARCH}.AppImage"
ARCH="$LD_ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$WORK/appimagetool.AppImage" "$WORK/appdir" "$TARGET"
chmod +x "$TARGET"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  npx --prefix "$PWD" tauri signer sign "$TARGET"
fi
echo "built $TARGET"
