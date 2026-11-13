# CreamFrame Installer

A desktop installer for **CreamFrame** (the maintained CreamAPI-style DLC
unlocker for Linux) with native Linux, Proton/Windows, Epic, Steam Frame/ARM64
and Android/Lepton support.

This project is a renamed fork of
[Novattz/creamlinux-installer](https://github.com/Novattz/creamlinux-installer)
and installs [CreamFrame](https://github.com/mitch030504/creamframe) instead of
the archived upstream CreamLinux releases.

> **Status:** CreamFrame 2.0 is in development. The local desktop installer and
> the Steam Frame remote/local flows are being built and tested against a real
> Steam Frame. Treat Android APK patching and experimental Frame builds as
> unsupported until a release marks them otherwise.

## Features

- **Local Linux:** discovers Steam libraries and installs CreamFrame for native
  Linux games, SmokeAPI for Proton games and ScreamAPI for Heroic/Epic games.
- **Steam Frame:** connects to `steamos@frame` over SSH, scans the Frame's
  Steam libraries, and manages the same unlockers remotely.
- **Android/Lepton:** patches a game's APK in place with the CreamFrame
  `libsteam_api.so` proxy, keeps the original as `<apk>.cream-backup`, and
  re-signs with a stable per-user key.
- **DLC selection:** fetches DLC lists from the Steam Store and writes the
  selected IDs into the game's `cream_api.ini` (or the APK proxy trailer).
- **Updates:** signed Tauri updates from this fork's releases.

## Requirements

### Desktop

- Linux x86_64 or aarch64
- WebKitGTK 4.1 (AppImage bundles its runtime)
- For Android patching: Python 3, `rsync`, Java, and Android build-tools
  (`zipalign`, `apksigner`); or use the bundled portable runtime on Steam Frame

### Steam Frame

1. On the Frame: **Steam Settings → System → Enable Developer Mode**.
2. Then **Settings → Developer → Set User Password**.
3. Verify from the PC:

```sh
ssh steamos@frame
```

The default remote is `steamos@frame`; it can be changed in the Steam Frame
page.

## Installing CreamFrame

### AppImage / deb / rpm

Download the latest artifact from
[the releases page](https://github.com/mitch030504/creamframe-installer/releases).

### Build from source

```sh
git clone https://github.com/mitch030504/creamframe-installer
cd creamframe-installer
npm ci
npm run tauri build
```

The binary is in `src-tauri/target/release/creamframe`.

## Steam Frame notes

- Android games run inside Valve's **Lepton** container. Patching the APK does
  not modify Lepton itself; Steam updates the game APK normally and the patch
  can be reapplied.
- Re-signing changes the app signature. Lepton may re-bake the container on the
  first launch; back up local saves or use Steam Cloud first.
- CreamFrame does not download DLC content. It only changes client-side
  entitlement checks.
- Do not use it in competitive or anti-cheat games.

The CLI remains available in the CreamFrame repository:

```sh
python3 tools/frame.py doctor
python3 tools/frame.py scan
python3 tools/frame.py android patch 1408230
python3 tools/frame.py android revert 1408230
```

## Credits

- [CreamFrame](https://github.com/mitch030504/creamframe) and the original
  creamlinux projects
- [Novattz/creamlinux-installer](https://github.com/Novattz/creamlinux-installer)
- [SmokeAPI](https://github.com/acidicoala/SmokeAPI)
- [ScreamAPI](https://github.com/acidicoala/ScreamAPI)
- [Tauri](https://tauri.app/), [React](https://reactjs.org/)

## License

MIT. See [LICENSE.md](LICENSE.md).

This fork contains AI-assisted work. AI-generated changes may contain mistakes
or unverified assumptions; review the source and test important behavior
independently.
