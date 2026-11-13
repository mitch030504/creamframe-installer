#!/usr/bin/env python3
"""Patch a Steam Frame Android APK with the CreamFrame libsteam_api proxy.

The APK's lib/arm64-v8a/libsteam_api.so is replaced by the proxy and the
original is shipped as libsteam_api_orig.so. The proxy reads its DLC list from
a trailer appended to itself, so no non-.so file has to survive Android's APK
native-library extraction.

The APK is re-signed with a stable per-user key. The original APK is not
modified by this script; the caller decides where to install the result.
"""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

MAGIC = b"CREAMCFG"
LIB_ENTRY = "lib/arm64-v8a/libsteam_api.so"
ORIG_ENTRY = "lib/arm64-v8a/libsteam_api_orig.so"
SIG_PATTERNS = [
    "META-INF/*.SF",
    "META-INF/*.DSA",
    "META-INF/*.RSA",
    "META-INF/*.EC",
    "META-INF/MANIFEST.MF",
]


def die(message: str) -> "NoReturn":
    print(f"apk_patch: {message}", file=sys.stderr)
    raise SystemExit(1)


def which(name: str, extra: list[str] | None = None) -> str | None:
    for candidate in extra or []:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which(name)
    return found


def android_build_tools() -> list[str]:
    """Return candidate build-tools dirs, newest first."""
    roots = []
    for env in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(env):
            roots.append(os.path.join(os.environ[env], "build-tools"))
    roots.append("/opt/android-sdk/build-tools")
    roots.append(os.path.expanduser("~/Android/Sdk/build-tools"))
    candidates: list[str] = []
    for root in roots:
        if os.path.isdir(root):
            for entry in os.listdir(root):
                path = os.path.join(root, entry)
                if os.path.isdir(path):
                    candidates.append(path)
    candidates.sort(key=lambda p: [int(x) if x.isdigit() else 0 for x in os.path.basename(p).split(".")],
                    reverse=True)
    return candidates


def tool(name: str) -> str:
    extra: list[str] = []
    for bt in android_build_tools():
        extra.append(os.path.join(bt, name))
    found = which(name, extra)
    if not found:
        die(f"required tool not found: {name} (set ANDROID_HOME or put Android build-tools on PATH)")
    return found


def run(cmd: list[str], cwd: str | None = None, check: bool = True,
        capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def default_keystore_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "creamframe"


def ensure_keystore(keystore: str, password_file: str, keytool: str | None = None) -> None:
    ks = Path(keystore)
    pw = Path(password_file)
    if ks.exists():
        if not pw.exists():
            die(f"keystore exists but password file is missing: {pw}")
        # apksigner reads the store password and the key password from the
        # same file when both --ks-pass and --key-pass point at it, so keep
        # two identical lines (older versions of this tool wrote one).
        lines = [line.strip() for line in pw.read_text().splitlines() if line.strip()]
        if len(lines) == 1:
            pw.write_text(lines[0] + "\n" + lines[0] + "\n")
            os.chmod(pw, 0o600)
        elif len(lines) < 2:
            die(f"password file is empty: {pw}")
        return

    keytool = keytool or which("keytool")
    if not keytool:
        die("keytool not found (install a JDK or pass CREAMFRAME_KEYTOOL)")
    ks.parent.mkdir(parents=True, exist_ok=True)
    pw.parent.mkdir(parents=True, exist_ok=True)
    password = secrets.token_urlsafe(24)
    # Store and key passwords are the same; apksigner's file: reader expects
    # the key password on the second line.
    pw.write_text(password + "\n" + password + "\n")
    os.chmod(pw, 0o600)
    run([
        keytool, "-genkeypair", "-noprompt",
        "-keystore", str(ks), "-alias", "cream",
        "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
        "-storepass", password, "-keypass", password,
        "-dname", "CN=CreamFrame Android",
    ])
    os.chmod(ks, 0o600)


def append_config(proxy_path: str, ini_path: str) -> bytes:
    proxy = Path(proxy_path).read_bytes()
    ini = Path(ini_path).read_bytes()
    if len(ini) > 16 * 1024 * 1024:
        die("cream_api.ini is too large")
    return proxy + ini + MAGIC + len(ini).to_bytes(4, "little")


def extract_original(apk: str) -> bytes:
    with zipfile.ZipFile(apk) as zf:
        names = set(zf.namelist())
        source = ORIG_ENTRY if ORIG_ENTRY in names else LIB_ENTRY if LIB_ENTRY in names else None
        if source is None:
            die(f"{apk} does not contain {LIB_ENTRY} or {ORIG_ENTRY}")
        return zf.read(source)


def patch_apk(apk: str, proxy: str, ini: str, output: str,
              keystore: str, password_file: str, *,
              zipalign_enabled: bool = True, sign_enabled: bool = True,
              apksigner_jar: str | None = None, java: str | None = None,
              keytool: str | None = None) -> None:
    if sign_enabled:
        ensure_keystore(keystore, password_file, keytool=keytool)
    zip_tool = tool("zip")
    tool("unzip")  # validates availability
    zipalign = tool("zipalign") if zipalign_enabled else None
    if sign_enabled:
        if apksigner_jar:
            apksigner = None
            java = java or tool("java")
        else:
            apksigner = tool("apksigner")
    else:
        apksigner = None

    original = extract_original(apk)
    proxy_bytes = append_config(proxy, ini)

    if not os.path.exists(apk):
        die(f"APK not found: {apk}")

    work = tempfile.mkdtemp(prefix="creamframe-apk-")
    try:
        stage = Path(work) / "stage"
        native = stage / "lib" / "arm64-v8a"
        native.mkdir(parents=True)
        (native / "libsteam_api.so").write_bytes(proxy_bytes)
        (native / "libsteam_api_orig.so").write_bytes(original)

        unsigned = Path(work) / "unsigned.apk"
        shutil.copyfile(apk, unsigned)

        # Remove the old signature files and both possible steam API entries.
        patterns = SIG_PATTERNS + [LIB_ENTRY, ORIG_ENTRY]
        run([zip_tool, "-q", "-d", str(unsigned)] + patterns,
            check=False)

        run([zip_tool, "-q", "-0", str(unsigned),
             LIB_ENTRY, ORIG_ENTRY], cwd=str(stage))

        if zipalign_enabled:
            aligned = Path(work) / "aligned.apk"
            result = subprocess.run([zipalign, "-P", "16", "-f", "4",
                                     str(unsigned), str(aligned)],
                                    text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE)
            if result.returncode != 0:
                # Older zipalign versions do not understand -P 16.
                result = subprocess.run([zipalign, "-p", "-f", "4",
                                         str(unsigned), str(aligned)],
                                        text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE)
            if result.returncode != 0:
                die(f"zipalign failed: {result.stderr.strip()}")
        else:
            aligned = unsigned

        if not sign_enabled:
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(aligned, output)
            return

        signed = Path(work) / "signed.apk"
        if apksigner_jar:
            sign_cmd = [java, "-jar", apksigner_jar, "sign"]
        else:
            sign_cmd = [apksigner, "sign"]
        sign_cmd += [
            "--ks", keystore,
            "--ks-key-alias", "cream",
            "--ks-pass", f"file:{password_file}",
            "--key-pass", f"file:{password_file}",
            "--out", str(signed), str(aligned),
        ]
        sign_result = subprocess.run(sign_cmd, text=True,
                                     stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        if sign_result.returncode != 0:
            die(f"apksigner failed: {sign_result.stderr.strip()}")
        if apksigner_jar:
            verify = run([java, "-jar", apksigner_jar, "verify", "--verbose", str(signed)], capture=True)
        else:
            verify = run([apksigner, "verify", "--verbose", str(signed)], capture=True)
        if "Verified using v2 scheme" not in (verify.stdout or "") and \
           "Verified using v3 scheme" not in (verify.stdout or ""):
            print(verify.stdout or "", file=sys.stderr)
            die("apksigner verification did not report a v2/v3 signature")

        Path(output).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(signed, output)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("apk", help="original APK")
    ap.add_argument("--proxy", required=True, help="Android libsteam_api.so proxy")
    ap.add_argument("--ini", required=True, help="per-game cream_api.ini")
    ap.add_argument("--output", required=True, help="patched APK to write")
    ap.add_argument("--keystore", default=str(default_keystore_dir() / "android.keystore"))
    ap.add_argument("--password-file", default=str(default_keystore_dir() / "android.keystore.pass"))
    ap.add_argument("--skip-zipalign", action="store_true",
                    help="portable/SteamOS mode; useful when no zipalign binary exists")
    ap.add_argument("--skip-sign", action="store_true")
    ap.add_argument("--apksigner-jar", help="use java -jar apksigner.jar (portable)")
    ap.add_argument("--java", help="java executable for --apksigner-jar")
    ap.add_argument("--keytool", help="keytool executable for keystore generation")
    args = ap.parse_args()

    patch_apk(args.apk, args.proxy, args.ini, args.output,
              args.keystore, args.password_file,
              zipalign_enabled=not args.skip_zipalign,
              sign_enabled=not args.skip_sign,
              apksigner_jar=args.apksigner_jar,
              java=args.java, keytool=args.keytool)
    print(f"patched APK written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
