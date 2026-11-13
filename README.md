# CreamFrame Installer

A desktop installer for **CreamFrame** (the maintained CreamAPI-style DLC
unlocker for Linux) with native Linux, Proton/Windows, Epic, Steam Frame/ARM64
and Android/Lepton support.

This project is a renamed fork of
[Novattz/creamlinux-installer](https://github.com/Novattz/creamlinux-installer)
and installs [CreamFrame](https://github.com/mitch030504/creamframe) instead of
the archived upstream CreamLinux releases.

> **Status:** CreamFrame Installer 2.0.3 is released for x86_64 and aarch64
> (AppImage and deb). The Steam Frame remote and on-device Android patch flows
> are validated against a real Frame with Walkabout Mini Golf. Beat Saber's
> first launch still requires accepting the Steam EULA in the headset.

## Features

- **Local Linux:** discovers Steam libraries and installs CreamFrame for native
  Linux games, SmokeAPI for Proton games and ScreamAPI for Heroic/Epic games.
- **Steam Frame:** connects to `steamos@frame` over SSH, scans the Frame's
  Steam libraries, and manages the same unlockers remotely.
- **On-device Android patching:** switch the Steam Frame page to **This device**
  to scan and patch Android/Lepton games installed on the machine running the
  installer.
- **Android/Lepton:** patches a game's APK with the CreamFrame `libsteam_api.so`
  proxy, keeps the original as `<apk>.cream-backup`, and re-signs with a stable
  per-user key. Lepton itself is never modified.
- **DLC selection:** fetches DLC lists from the Steam Store and writes the
  selected IDs into the game's `cream_api.ini` (or the APK proxy trailer).
- **Updates:** signed Tauri updates from this fork's releases.

## Requirements

### Desktop

- Linux x86_64 or aarch64
- WebKitGTK 4.1 (the AppImage bundles its runtime)
- For Android patching: Python 3, `rsync`, Java, and Android build-tools
  (`zipalign`, `apksigner`); or use the bundled portable runtime in the
  AppImage

The AppImage bundles the WebKit helpers, ICU and a Temurin JRE. The deb relies
on the host's WebKitGTK and Java for Android patching.

### Steam Frame

1. On the Frame: **Steam Settings → System → Enable Developer Mode**.
2. Then **Settings → Developer → Set User Password**.
3. Verify from the PC:

```sh
ssh steamos@frame
```

The default remote is `steamos@frame`; it can be changed in the Steam Frame
page. For on-device patching, launch the installer in Desktop Mode.

## Installing CreamFrame Installer

### AppImage / deb

Download the latest artifact from
[the releases page](https://github.com/mitch030504/creamframe-installer/releases).

```sh
chmod +x CreamFrame_2.0.3_*.AppImage
./CreamFrame_2.0.3_*.AppImage
```

### Build from source

```sh
git clone https://github.com/mitch030504/creamframe-installer
cd creamframe-installer
npm ci
npm run tauri build -- --bundles deb
bash scripts/build-appimage-ci.sh   # optional AppImage
```

The binary is in `src-tauri/target/release/creamframe`.

## Using the Steam Frame page

- **Remote Frame** runs `frame.py` over SSH against `steamos@frame`. It lists
  Android, native and Proton games, and can install/uninstall CreamFrame or
  SmokeAPI on the Frame.
- **This device** runs the same tooling locally. It only lists Android games;
  native and Proton games on the local machine are handled from the Library
  tab.
- **Patch APK** fetches the game's DLC list, lets you choose which entries to
  enable, and then patches and re-signs the APK on the target. **Revert**
  restores `<apk>.cream-backup`.

On the first launch after patching, Lepton may re-bake the game container. Back
up local saves or use Steam Cloud first.

## Steam Frame notes

- Android games run inside Valve's **Lepton** container. Patching the APK does
  not modify Lepton itself; Steam updates the game APK normally and the patch
  can be reapplied.
- Re-signing changes the app signature. Lepton may re-bake the container on the
  first launch.
- CreamFrame does not download DLC content. It only changes client-side
  entitlement checks.
- Do not use it in competitive or anti-cheat games.

The CLI remains available in the CreamFrame repository:

```sh
python3 tools/frame.py doctor
python3 tools/frame.py scan
python3 tools/frame.py android patch 1408230
python3 tools/frame.py android revert 1408230
python3 tools/frame.py --local android patch 1408230
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
