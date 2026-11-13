#!/usr/bin/env python3
"""CreamFrame: manage DLC unlocking on a Steam Frame over SSH.

The default remote is steamos@frame, matching the Steam Frame developer-mode
SSH setup. No Steam or Lepton files are patched in place by the Android path:
the game APK is backed up, patched, re-signed and put back, so a Steam update
simply restores the original APK and the patch can be reapplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_REMOTE = os.environ.get("CREAM_FRAME_REMOTE", "steamos@frame")
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "creamframe"
ANDROID_PROXY_CANDIDATES = [
    REPO / "build" / "android" / "lib" / "libsteam_api.so",
    REPO / "dist" / "android" / "libsteam_api.so",
    REPO / "android" / "libsteam_api.so",
]


# ---------------------------------------------------------------- remote ---

REMOTE_SCAN = r'''
import json, os, re, zipfile
from pathlib import Path

STEAM = Path.home() / ".local/share/Steam"

def paths_from_vdf(path):
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return []
    return re.findall(r'"path"\s+"([^"]+)"', text)

def manifest_field(text, name):
    match = re.search(r'"%s"\s+"([^"]*)"' % re.escape(name), text)
    return match.group(1) if match else ""

libraries = []
for candidate in [STEAM] + [Path(p) for p in paths_from_vdf(STEAM / "steamapps" / "libraryfolders.vdf")]:
    if candidate not in libraries:
        libraries.append(candidate)

games = []
for library in libraries:
    steamapps = library / "steamapps"
    if not steamapps.is_dir():
        continue
    for manifest in sorted(steamapps.glob("appmanifest_*.acf")):
        try:
            text = manifest.read_text(errors="replace")
        except OSError:
            continue
        appid = manifest_field(text, "appid")
        name = manifest_field(text, "name")
        installdir = manifest_field(text, "installdir")
        if not appid or not installdir:
            continue
        game_dir = steamapps / "common" / installdir
        if not game_dir.is_dir():
            continue

        apk_path = None
        apk_size = 0
        apk_has_steam = False
        apk_patched = False
        for apk in sorted(game_dir.glob("*.apk")):
            try:
                with zipfile.ZipFile(apk) as zf:
                    names = set(zf.namelist())
            except Exception:
                continue
            if "lib/arm64-v8a/libsteam_api.so" in names:
                apk_path = str(apk)
                apk_size = apk.stat().st_size
                apk_has_steam = True
                apk_patched = "lib/arm64-v8a/libsteam_api_orig.so" in names
                break

        native_lib = None
        proton_dll = None
        if not apk_has_steam:
            root_depth = str(game_dir).rstrip(os.sep).count(os.sep)
            for dirpath, dirnames, filenames in os.walk(game_dir):
                dirnames.sort()
                filenames.sort()
                depth = dirpath.rstrip(os.sep).count(os.sep) - root_depth
                if depth > 6:
                    dirnames[:] = []
                    continue
                for filename in filenames:
                    if filename == "libsteam_api.so" and native_lib is None:
                        native_lib = os.path.join(dirpath, filename)
                    if filename in ("steam_api.dll", "steam_api64.dll") and proton_dll is None:
                        proton_dll = os.path.join(dirpath, filename)
                if native_lib is not None:
                    break

        game_type = None
        if apk_has_steam:
            game_type = "android"
        elif native_lib is not None:
            game_type = "native"
        elif proton_dll is not None:
            game_type = "proton"

        backup = (apk_path + ".cream-backup") if apk_path else None
        manifest_path = (apk_path + ".cream.json") if apk_path else None
        patch_info = None
        if manifest_path:
            try:
                patch_info = json.loads(Path(manifest_path).read_text())
            except Exception:
                patch_info = None

        games.append({
            "appid": appid,
            "name": name,
            "installdir": installdir,
            "game_dir": str(game_dir),
            "library": str(library),
            "compatdata": str(steamapps / "compatdata" / appid),
            "type": game_type,
            "apk_path": apk_path,
            "apk_size": apk_size,
            "apk_patched": apk_patched,
            "apk_backup": backup if backup and os.path.exists(backup) else None,
            "patch_info": patch_info,
            "native_lib": native_lib,
            "proton_dll": proton_dll,
        })

print(json.dumps({"steam": str(STEAM), "libraries": [str(p) for p in libraries],
                  "games": games}))
'''


def run(cmd, input_text=None, capture=True, check=False):
    return subprocess.run(
        cmd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=check,
    )


def ssh(remote, command, input_text=None, capture=True, check=False):
    return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                remote, command], input_text=input_text, capture=capture, check=check)


def scan(remote):
    result = ssh(remote, "python3 -", input_text=REMOTE_SCAN)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "remote scan failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"remote scan returned invalid JSON: {exc}\n{result.stdout[:500]}")


def find_game(remote, appid):
    data = scan(remote)
    for game in data["games"]:
        if str(game["appid"]) == str(appid):
            return game, data
    raise SystemExit(f"app {appid} not found in the Frame's Steam libraries")


def remote_sha256(remote, path):
    result = ssh(remote, f"sha256sum -- {shlex.quote(path)}")
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or f"cannot hash {path}")
    return result.stdout.split()[0]


def remote_bool(remote, condition):
    return ssh(remote, condition).returncode == 0


def rsync_down(remote, remote_path, local_path):
    local_path.parent.mkdir(parents=True, exist_ok=True)
    result = run(["rsync", "-s", "--partial", "--info=progress2",
                  f"{remote}:{remote_path}", str(local_path)], capture=False)
    if result.returncode != 0:
        raise SystemExit(f"rsync download failed: {remote_path}")


def rsync_up(remote, local_path, remote_path):
    result = run(["rsync", "-s", "--partial", "--info=progress2",
                  str(local_path), f"{remote}:{remote_path}"], capture=False)
    if result.returncode != 0:
        raise SystemExit(f"rsync upload failed: {remote_path}")


def remote_write(remote, path, text):
    result = ssh(remote, f"cat > {shlex.quote(path)}", input_text=text)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or f"cannot write {path}")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def quote(path):
    return shlex.quote(str(path))


# ------------------------------------------------------------------- dlc ---

def fetch_dlc(appid):
    url = (f"https://store.steampowered.com/api/appdetails?appids={appid}"
           "&filters=basic,dlc")
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = json.load(response)
    except Exception as exc:
        print(f"warning: could not fetch DLC list for {appid}: {exc}", file=sys.stderr)
        return []
    data = payload.get(str(appid), {})
    if not data.get("success"):
        return []
    dlc_ids = data.get("data", {}).get("dlc") or []
    result = []
    for dlc_id in dlc_ids:
        name = f"DLC {dlc_id}"
        try:
            detail_url = (f"https://store.steampowered.com/api/appdetails?"
                          f"appids={dlc_id}&filters=basic")
            with urllib.request.urlopen(detail_url, timeout=20) as response:
                detail = json.load(response)
            entry = detail.get(str(dlc_id), {})
            if entry.get("success"):
                name = entry["data"].get("name", name)
        except Exception:
            pass
        result.append((int(dlc_id), name))
    return result


def make_ini(appid, dlc, unlockall=False):
    lines = [
        "[config]",
        f"unlockall = {'true' if unlockall else 'false'}",
        "logging = true",
        "",
        "[methods]",
        "disable_steamapps_issubscribedapp = false",
        "",
        "[dlc]",
    ]
    for dlc_id, name in dlc:
        lines.append(f"{dlc_id} = {name}")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------- patcher ---

def android_proxy():
    override = os.environ.get("CREAMFRAME_ANDROID_PROXY")
    if override:
        if Path(override).is_file():
            return Path(override)
        raise SystemExit(f"CREAMFRAME_ANDROID_PROXY does not exist: {override}")
    for candidate in ANDROID_PROXY_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise SystemExit(
        "Android proxy not built. Run: sh ./build-android.sh\n"
        f"Looked in: {', '.join(str(p) for p in ANDROID_PROXY_CANDIDATES)}"
    )


def ensure_android_patch_import():
    sys.path.insert(0, str(HERE))
    import apk_patch  # noqa: F401
    return apk_patch


def local_apk_cache(remote, game):
    appid = game["appid"]
    cache_dir = CACHE / "android" / appid
    cache_dir.mkdir(parents=True, exist_ok=True)
    remote_hash = remote_sha256(remote, game["apk_path"])
    local_apk = cache_dir / "source.apk"
    hash_file = cache_dir / "source.sha256"
    if not local_apk.exists() or not hash_file.exists() or \
            hash_file.read_text().strip() != remote_hash:
        print(f"Downloading {game['name']} APK ({game['apk_size'] / 1e6:.1f} MB)...")
        rsync_down(remote, game["apk_path"], local_apk)
        actual = sha256_file(local_apk)
        if actual != remote_hash:
            raise SystemExit(f"APK hash mismatch after download: {actual} != {remote_hash}")
        hash_file.write_text(actual + "\n")
    return local_apk, remote_hash


# --------------------------------------------------------------- commands ---

def cmd_doctor(args):
    print(f"remote: {args.remote}")
    result = ssh(args.remote, "uname -m; hostname; python3 --version")
    if result.returncode != 0:
        print("FAIL: SSH failed:", result.stderr.strip())
        return 1
    lines = result.stdout.strip().splitlines()
    arch = lines[0] if lines else "?"
    print(f"  SSH: ok ({'aarch64' if arch == 'aarch64' else arch}, {lines[1] if len(lines) > 1 else '?'})")
    if arch != "aarch64":
        print("  WARN: Steam Frame is expected to be aarch64")

    try:
        data = scan(args.remote)
        print(f"  Steam: {data['steam']} ({len(data['games'])} installed apps)")
    except SystemExit as exc:
        print("  FAIL: remote scan:", exc)
        return 1

    lepton = Path("/home/steamos/.local/share/Steam/steamapps/common/Lepton/lepton")
    check = ssh(args.remote, f"test -x {quote(lepton)}")
    print(f"  Lepton: {'ok' if check.returncode == 0 else 'MISSING'}")

    host_tools = ["zip", "unzip", "zipalign", "apksigner", "keytool", "java"]
    for tool in host_tools:
        print(f"  host {tool}: {shutil.which(tool) or 'MISSING'}")
    try:
        proxy = android_proxy()
        print(f"  Android proxy: {proxy}")
    except SystemExit as exc:
        print(f"  Android proxy: MISSING ({exc})")

    arm_lib = find_native_lib("aarch64")
    print(f"  aarch64 creamlinux: {arm_lib or 'not built (use GitHub Actions or build on the Frame)'}")
    print(f"  Android cache: {CACHE / 'android'}")
    return 0


def cmd_scan(args):
    data = scan(args.remote)
    if args.json:
        print(json.dumps(data, indent=2))
        return 0
    print(f"{'APPID':<10}{'TYPE':<9}{'STATE':<22}GAME")
    print("-" * 100)
    for game in sorted(data["games"], key=lambda item: item["name"].lower()):
        state = ""
        if game["type"] == "android":
            if game["apk_patched"]:
                state = "patched"
            elif game["apk_backup"]:
                state = "backup present"
            else:
                state = "not patched"
        print(f"{game['appid']:<10}{str(game['type'] or '-'):<9}{state:<22}{game['name']}")
    return 0


def cmd_android_patch(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "android" or not game["apk_path"]:
        raise SystemExit(f"{game['name']} is not an Android/Lepton game")
    if game["apk_patched"] and not game["apk_backup"]:
        raise SystemExit(
            "The APK is already patched but has no .cream-backup; refusing to "
            "overwrite the only original copy. Re-run Steam's verify integrity "
            "first, or restore a known-good original APK."
        )

    cache_dir = CACHE / "android" / game["appid"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    if args.ini:
        ini_text = Path(args.ini).read_text()
        dlc_count = len(re.findall(r"^\s*\d+\s*=", ini_text, re.MULTILINE))
        print(f"Using custom ini: {args.ini} ({dlc_count} DLC entries)")
    else:
        dlc = fetch_dlc(game["appid"])
        dlc_count = len(dlc)
        ini_text = make_ini(game["appid"], dlc, unlockall=args.unlockall)
        print(f"DLC list: {dlc_count} entries from the Steam Store")
    ini_path = cache_dir / "cream_api.ini"
    ini_path.write_text(ini_text)

    local_apk, remote_hash = local_apk_cache(args.remote, game)
    original_hash = remote_hash
    if game["apk_patched"] and game.get("patch_info"):
        original_hash = game["patch_info"].get("original_sha256", remote_hash)
    elif game["apk_patched"] and game.get("apk_backup"):
        original_hash = remote_sha256(args.remote, game["apk_backup"])
    patched = cache_dir / "patched.apk"
    patch_apk = ensure_android_patch_import().patch_apk
    keystore = str(Path(args.keystore).expanduser())
    password = str(Path(args.password_file).expanduser())

    if args.dry_run:
        print(f"Would patch {game['apk_path']} -> {patched}")
        print(f"  proxy: {android_proxy()}")
        print(f"  ini:   {ini_path} ({dlc_count} entries)")
        return 0

    print("Patching and signing APK locally...")
    try:
        portable = os.environ.get("CREAMFRAME_NO_ZIPALIGN") == "1"
        patch_apk(
            str(local_apk), str(android_proxy()), str(ini_path),
            str(patched), keystore, password,
            zipalign_enabled=not portable,
            apksigner_jar=os.environ.get("CREAMFRAME_APKSIGNER_JAR"),
            java=os.environ.get("CREAMFRAME_JAVA"),
            keytool=os.environ.get("CREAMFRAME_KEYTOOL"),
        )
    except Exception as exc:  # noqa: BLE001 - show a clean CLI error
        raise SystemExit(f"APK patch failed: {exc}")
    patched_hash = sha256_file(patched)
    if patched_hash == remote_hash:
        print("Already patched with the current proxy/config; nothing to upload.")
        return 0

    remote_tmp = game["apk_path"] + ".cream-new"
    remote_manifest = game["apk_path"] + ".cream.json"
    backup = game["apk_path"] + ".cream-backup"

    print("Backing up the original APK on the Frame...")
    backup_cmd = f'''
set -e
apk={quote(game["apk_path"])}
backup={quote(backup)}
if [ ! -f "$backup" ] || [ "{1 if game["apk_patched"] else 0}" = "0" ]; then
    cp -p "$apk" "$backup"
fi
'''
    result = ssh(args.remote, backup_cmd)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "remote backup failed")

    print(f"Uploading patched APK ({patched.stat().st_size / 1e6:.1f} MB)...")
    rsync_up(args.remote, patched, remote_tmp)
    if remote_sha256(args.remote, remote_tmp) != patched_hash:
        raise SystemExit("uploaded APK hash mismatch on the Frame")
    result = ssh(args.remote, f"mv -f {quote(remote_tmp)} {quote(game['apk_path'])}")
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "remote APK replace failed")

    manifest = {
        "appid": game["appid"],
        "original_sha256": original_hash,
        "patched_sha256": patched_hash,
        "dlc_count": dlc_count,
        "proxy": str(android_proxy()),
        "created": subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
                                  text=True, capture_output=True).stdout.strip(),
    }
    remote_write(args.remote, remote_manifest, json.dumps(manifest, indent=2) + "\n")
    print("Patched. Launch the game from Steam; the first launch may re-bake its Lepton container.")
    if args.launch:
        print("Requesting launch...")
        ssh(args.remote, f"steam -applaunch {int(game['appid'])}", capture=False)
    return 0


def cmd_android_status(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "android":
        raise SystemExit(f"{game['name']} is not an Android/Lepton game")
    current = remote_sha256(args.remote, game["apk_path"])
    info = game.get("patch_info")
    print(f"{game['name']} ({game['appid']})")
    print(f"  APK: {game['apk_path']}")
    if not info:
        print("  state: original / not patched")
        return 0
    if current == info.get("patched_sha256"):
        print(f"  state: patched ({info.get('dlc_count', '?')} DLC entries)")
    elif current == info.get("original_sha256"):
        print("  state: original (patch gone; Steam updated or verified the APK)")
    else:
        print("  state: APK changed since the patch; re-run android patch")
    print(f"  backup: {game.get('apk_backup') or 'missing'}")
    return 0


def cmd_android_revert(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "android":
        raise SystemExit(f"{game['name']} is not an Android/Lepton game")
    info = game.get("patch_info") or {}
    current = remote_sha256(args.remote, game["apk_path"])
    backup = game["apk_path"] + ".cream-backup"
    have_backup = remote_bool(args.remote, f"test -f {quote(backup)}")
    if not have_backup:
        raise SystemExit("No .cream-backup APK found")
    backup_hash = remote_sha256(args.remote, backup)
    if current == backup_hash:
        print("APK is already the original; removing stale patch metadata.")
    elif info and current == info.get("patched_sha256"):
        if args.dry_run:
            print(f"Would restore {backup} -> {game['apk_path']}")
            return 0
        result = ssh(args.remote, f"mv -f {quote(backup)} {quote(game['apk_path'])}")
        if result.returncode != 0:
            raise SystemExit(result.stderr.strip() or "restore failed")
        print("Restored the original APK.")
    elif args.force:
        if args.dry_run:
            print(f"Would force-restore {backup} -> {game['apk_path']}")
            return 0
        result = ssh(args.remote, f"mv -f {quote(backup)} {quote(game['apk_path'])}")
        if result.returncode != 0:
            raise SystemExit(result.stderr.strip() or "restore failed")
        print("Force-restored the backed-up APK.")
    else:
        raise SystemExit(
            "The current APK is neither the patched file nor the backup "
            "(Steam likely updated it). The existing backup is stale; "
            "re-run android patch for the new version, or use --force to "
            "restore the old backup anyway."
        )
    if not args.keep_backup:
        ssh(args.remote, f"rm -f {quote(backup)} {quote(game['apk_path'] + '.cream.json')}")
    print("Reverted. Launch the game to let Lepton re-bake with the original APK.")
    return 0


def cmd_android_uninstall(args):
    args.keep_backup = False
    return cmd_android_revert(args)


def cmd_android_reset(args):
    """Drop Lepton's baked app state so the next launch re-installs the APK.

    This is the recovery path when switching between the original and patched
    signatures, or after a game update. The `internal` save data is untouched.
    """
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "android":
        raise SystemExit(f"{game['name']} is not an Android/Lepton game")
    baked = os.path.join(game["compatdata"], "baked")
    lepton = "/home/steamos/.local/share/Steam/steamapps/common/Lepton/lepton"
    context = f"steamlaunch-{game['appid']}"
    container = "lepton-" + context
    running = ssh(args.remote,
                  "podman ps --format '{{.Names}}' 2>/dev/null | "
                  f"grep -q {quote(container)}")
    if running.returncode == 0:
        raise SystemExit(f"{context} is running; close the game before resetting")
    if args.dry_run:
        print(f"Would remove {baked} (saves in internal/ are kept)")
        return 0
    result = ssh(args.remote, f"rm -rf {quote(baked)}")
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or "could not remove baked state")
    print("Cleared Lepton baked state. Launch the game to re-install its APK.")
    return 0


# --------------------------------------------------------------- native ---

def find_native_lib(arch):
    name = "lib32Creamlinux.so" if arch in ("i386", "arm") else "lib64Creamlinux.so"
    candidates = [
        REPO / "build" / arch / "lib" / name,
        REPO / "dist" / arch / name,
        REPO / arch / name,
    ]
    host_arch = os.uname().machine
    if arch == "x86_64" and host_arch in ("x86_64", "amd64"):
        candidates.insert(0, REPO / "build" / "host" / "lib" / name)
        candidates.extend([REPO / name, REPO / "output" / name])
    if arch == "i386" and host_arch in ("x86_64", "amd64"):
        candidates.insert(0, REPO / "build" / "32" / "lib" / name)
        candidates.append(REPO / "output" / name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def remote_elf_machine(remote, path):
    result = ssh(remote, f"od -An -t x1 -j 18 -N 2 {quote(path)}")
    if result.returncode != 0:
        return "unknown"
    machine = result.stdout.strip().replace(" ", "").lower()
    return {"3e00": "x86_64", "0300": "i386", "b700": "aarch64",
            "2800": "arm"}.get(machine, "unknown")


def cmd_native_install(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "native" or not game["native_lib"]:
        raise SystemExit(f"{game['name']} is not a native Linux game")
    arch = remote_elf_machine(args.remote, game["native_lib"])
    lib = find_native_lib(arch)
    if not lib:
        raise SystemExit(f"no local {arch} creamlinux build found; build it first")
    ini = make_ini(game["appid"], fetch_dlc(game["appid"]), unlockall=args.unlockall)
    if args.dry_run:
        print(f"Would install {lib} + cream.sh + cream_api.ini into {game['game_dir']}")
        return 0
    lib_name = "lib32Creamlinux.so" if arch in ("i386", "arm") else "lib64Creamlinux.so"
    target = os.path.join(game["game_dir"], lib_name)
    rsync_up(args.remote, lib, target)
    cream_sh = REPO / "package" / "cream.sh"
    if not cream_sh.is_file():
        cream_sh = REPO / "cream.sh"
    rsync_up(args.remote, cream_sh, os.path.join(game["game_dir"], "cream.sh"))
    tmp_ini = CACHE / "native" / f"{game['appid']}.ini"
    tmp_ini.parent.mkdir(parents=True, exist_ok=True)
    tmp_ini.write_text(ini)
    rsync_up(args.remote, tmp_ini, os.path.join(game["game_dir"], "cream_api.ini"))
    print(f"Installed creamlinux for {game['name']} ({arch}).")
    print("Set the game's Steam launch options to:  sh ./cream.sh %command%")
    return 0


def cmd_native_uninstall(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "native":
        raise SystemExit(f"{game['name']} is not a native Linux game")
    if not args.dry_run:
        ssh(args.remote, "rm -f " + " ".join(quote(os.path.join(game["game_dir"], name))
                                             for name in ("lib64Creamlinux.so", "lib32Creamlinux.so",
                                                          "cream.sh", "cream_api.ini")))
    print("Removed creamlinux files.")
    return 0


# --------------------------------------------------------------- proton ---

def upload_tools(remote):
    remote_dir = "/home/steamos/.local/share/creamframe/tools"
    ssh(remote, f"mkdir -p {quote(remote_dir)}")
    for name in ("setup.py", "creamlib.py", "update-dlc.py"):
        rsync_up(remote, REPO / "tools" / name, os.path.join(remote_dir, name))
    return remote_dir


def cmd_proton_install(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "proton":
        raise SystemExit(f"{game['name']} is not a Proton/Windows game")
    ini = make_ini(game["appid"], fetch_dlc(game["appid"]), unlockall=args.unlockall)
    tmp_ini = CACHE / "proton" / f"{game['appid']}.ini"
    tmp_ini.parent.mkdir(parents=True, exist_ok=True)
    tmp_ini.write_text(ini)
    remote_dir = upload_tools(args.remote)
    if args.dry_run:
        print(f"Would run setup.py --install {game['appid']} --smokeapi-mode {args.smokeapi_mode}")
        return 0
    cmd = (f"python3 {quote(os.path.join(remote_dir, 'setup.py'))} "
           f"--install {int(game['appid'])} --smokeapi-mode {args.smokeapi_mode}")
    result = ssh(args.remote, cmd, capture=False)
    if result.returncode != 0:
        raise SystemExit("remote setup.py failed")
    rsync_up(args.remote, tmp_ini, os.path.join(game["game_dir"], "cream_api.ini"))
    print("Installed SmokeAPI and the per-game cream_api.ini.")
    print("No launch options are needed; launch the game from Steam.")
    return 0


def cmd_proton_uninstall(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] != "proton":
        raise SystemExit(f"{game['name']} is not a Proton/Windows game")
    remote_dir = upload_tools(args.remote)
    cmd = (f"python3 {quote(os.path.join(remote_dir, 'setup.py'))} "
           f"--uninstall {int(game['appid'])} --keep-ini")
    if not args.dry_run:
        ssh(args.remote, cmd, capture=False)
        ssh(args.remote, f"rm -f {quote(os.path.join(game['game_dir'], 'cream_api.ini'))}")
    print("Removed SmokeAPI files.")
    return 0


# ------------------------------------------------------------------ logs ---

def cmd_logs(args):
    game, _ = find_game(args.remote, args.appid)
    if game["type"] == "android":
        lepton = "/home/steamos/.local/share/Steam/steamapps/common/Lepton/lepton"
        context = f"steamlaunch-{game['appid']}"
        cmd = (f"timeout 8 {quote(lepton)} logcat {quote(context)} 2>/dev/null | "
               "grep -i creamlinux || true")
        result = ssh(args.remote, cmd)
        print(result.stdout, end="")
        return 0
    print("For native games, run the game from a terminal or use Steam's "
          "console output; Android logcat is the supported log path.")
    return 0


# ------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--remote", default=DEFAULT_REMOTE,
                    help=f"SSH destination (default: {DEFAULT_REMOTE})")
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", help="check SSH, Steam, Lepton and host tools").set_defaults(func=cmd_doctor)
    scan_parser = sub.add_parser("scan", help="list installed games and patch state")
    scan_parser.add_argument("--json", action="store_true", help="machine-readable output")
    scan_parser.set_defaults(func=cmd_scan)

    android = sub.add_parser("android", help="Steam Frame Android/Lepton games")
    android_sub = android.add_subparsers(dest="android_command", required=True)
    patch = android_sub.add_parser("patch", help="patch a game's APK with the proxy")
    patch.add_argument("appid", type=int)
    patch.add_argument("--ini", help="use a custom cream_api.ini")
    patch.add_argument("--unlockall", action="store_true")
    patch.add_argument("--dry-run", action="store_true")
    patch.add_argument("--launch", action="store_true")
    patch.add_argument("--keystore", default=str(Path.home() / ".config" / "creamframe" / "android.keystore"))
    patch.add_argument("--password-file", default=str(Path.home() / ".config" / "creamframe" / "android.keystore.pass"))
    patch.set_defaults(func=cmd_android_patch)
    status = android_sub.add_parser("status", help="show patch state")
    status.add_argument("appid", type=int)
    status.set_defaults(func=cmd_android_status)
    revert = android_sub.add_parser("revert", help="restore the original APK")
    revert.add_argument("appid", type=int)
    revert.add_argument("--force", action="store_true")
    revert.add_argument("--keep-backup", action="store_true")
    revert.add_argument("--dry-run", action="store_true")
    revert.set_defaults(func=cmd_android_revert)
    uninstall = android_sub.add_parser("uninstall", help="restore and remove backup")
    uninstall.add_argument("appid", type=int)
    uninstall.add_argument("--force", action="store_true")
    uninstall.add_argument("--dry-run", action="store_true")
    uninstall.set_defaults(func=cmd_android_uninstall)
    reset = android_sub.add_parser("reset", help="clear Lepton baked app state")
    reset.add_argument("appid", type=int)
    reset.add_argument("--dry-run", action="store_true")
    reset.set_defaults(func=cmd_android_reset)

    native = sub.add_parser("native", help="native Linux/ARM64 games")
    native_sub = native.add_subparsers(dest="native_command", required=True)
    ni = native_sub.add_parser("install")
    ni.add_argument("appid", type=int)
    ni.add_argument("--unlockall", action="store_true")
    ni.add_argument("--dry-run", action="store_true")
    ni.set_defaults(func=cmd_native_install)
    nu = native_sub.add_parser("uninstall")
    nu.add_argument("appid", type=int)
    nu.add_argument("--dry-run", action="store_true")
    nu.set_defaults(func=cmd_native_uninstall)

    proton = sub.add_parser("proton", help="Windows/Proton games (SmokeAPI)")
    proton_sub = proton.add_subparsers(dest="proton_command", required=True)
    pi = proton_sub.add_parser("install")
    pi.add_argument("appid", type=int)
    pi.add_argument("--smokeapi-mode", choices=["hook", "koaloader", "proxy"], default="proxy")
    pi.add_argument("--unlockall", action="store_true")
    pi.add_argument("--dry-run", action="store_true")
    pi.set_defaults(func=cmd_proton_install)
    pu = proton_sub.add_parser("uninstall")
    pu.add_argument("appid", type=int)
    pu.add_argument("--dry-run", action="store_true")
    pu.set_defaults(func=cmd_proton_uninstall)

    logs = sub.add_parser("logs", help="show Android logcat creamlinux lines")
    logs.add_argument("appid", type=int)
    logs.set_defaults(func=cmd_logs)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
