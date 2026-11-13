#!/bin/bash
# cream.sh - launch a game with CreamFrame DLC unlock hooks.
#
# Usage in Steam launch options:
#   sh ./cream.sh %command%
#   sh ./cream.sh mangohud %command%   # with MangoHud (see below)
#
# Notes:
# - Steam may launch games from a different working directory (issue #62),
#   so all paths are resolved relative to this script's own location.
# - The libraries are copied into a private temp dir: unique per launch
#   (no races between parallel game starts) and guaranteed to contain no
#   spaces, which LD_PRELOAD cannot handle. Steam Linux Runtime
#   (pressure-vessel) shares the host /tmp with the game container, so the
#   preload also works for games launched through a runtime (issue #71).
copy_file() {
    cp "$1" "$2" || { echo "Error: Failed to copy $1 to $2"; exit 1; }
}

# Steam may launch games from a different working directory (issue #62), so
# always resolve paths relative to this script's own location.
cd "$(dirname "$(readlink -f "$0")")"

# MangoHud compatibility (issue #51): MangoHud's wrapper appends itself to
# LD_PRELOAD, and our dlsym interposition must not confuse it. MANGOHUD_DLSYM
# is a no-op on modern MangoHud (dlsym is the default) but keeps older
# versions working.
if [ "$1" = "mangohud" ]; then
    export MANGOHUD=1
    export MANGOHUD_DLSYM=1
    echo "cream.sh: MangoHud detected, setting MANGOHUD=1 and MANGOHUD_DLSYM=1"
fi

LIBSTEAM_API_DIR=$(find . -name "libsteam_api.so" -printf "%h\n" | head -n 1)
[ -z "$LIBSTEAM_API_DIR" ] && { echo "Error: libsteam_api.so not found."; exit 1; }
if [ ! -z "$CREAM_CONFIG_PATH" ]; then
    # Accept both a path to the ini file and a directory containing cream_api.ini
    if [ -d "$CREAM_CONFIG_PATH" ]; then
        CREAM_CONFIG_PATH="$CREAM_CONFIG_PATH/cream_api.ini"
    fi
    if [ ! -f "$CREAM_CONFIG_PATH" ]; then
        echo "Error: cream_api.ini not found at CREAM_CONFIG_PATH ($CREAM_CONFIG_PATH)."; exit 1;
    fi
    export CREAM_CONFIG_PATH
else
    if [ ! -f "$PWD/cream_api.ini" ]; then
        echo "Error: cream_api.ini not found in the current working directory."; exit 1;
    fi
fi
if [ -z "$CREAM_CONFIG_PATH" ] && [ "$LIBSTEAM_API_DIR" != "$PWD" ]; then
    export CREAM_CONFIG_PATH="$PWD/cream_api.ini"
fi

# Private temp dir; if TMPDIR itself contains spaces (LD_PRELOAD cannot
# handle them), fall back to /tmp.
if [ -n "${TMPDIR:-}" ] && printf '%s' "$TMPDIR" | grep -q ' '; then
    TMPDIR=/tmp
fi
CREAM_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/creamlinux.XXXXXX") || {
    echo "Error: cannot create temporary directory."; exit 1;
}
trap 'rm -rf "$CREAM_TMPDIR"' EXIT

copy_file "$LIBSTEAM_API_DIR/libsteam_api.so" "$CREAM_TMPDIR/libsteam_api.so"

# Select the creamlinux library that matches the game's architecture, not the
# host's. Steam Frame runs x86-64 games through FEX on an aarch64 host, and a
# distribution can contain both aarch64 and x86-64 builds.
#
# e_machine is the little-endian 16-bit field at offset 18:
#   0x3e = x86-64, 0x03 = i386, 0xb7 = aarch64, 0x28 = arm
elf_machine() {
    od -An -t x1 -j 18 -N 2 "$1" 2>/dev/null | tr -d ' \n'
}

GAME_MACHINE=$(elf_machine "$CREAM_TMPDIR/libsteam_api.so")
case "$GAME_MACHINE" in
    3e00) GAME_ARCH=x86_64 ;;
    0300) GAME_ARCH=i386 ;;
    b700) GAME_ARCH=aarch64 ;;
    2800) GAME_ARCH=arm ;;
    *)    GAME_ARCH=unknown ;;
esac

pick_lib() {
    local arch="$1"
    local candidate
    for candidate in \
        "$arch/lib64Creamlinux.so" \
        "$arch/lib32Creamlinux.so" \
        "lib64Creamlinux.so" \
        "lib32Creamlinux.so"; do
        [ -f "$candidate" ] || continue
        if [ "$(elf_machine "$candidate")" = "$GAME_MACHINE" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

CREAM_LIB=""
case "$GAME_ARCH" in
    x86_64)
        CREAM_LIB=$(pick_lib x86_64) || true
        LIB_NAME=lib64Creamlinux.so
        ;;
    i386)
        CREAM_LIB=$(pick_lib i386) || true
        LIB_NAME=lib32Creamlinux.so
        ;;
    aarch64)
        CREAM_LIB=$(pick_lib aarch64) || true
        LIB_NAME=lib64Creamlinux.so
        ;;
    arm)
        CREAM_LIB=$(pick_lib arm) || true
        LIB_NAME=lib32Creamlinux.so
        ;;
    *)
        # Unknown machine: preserve the old behaviour and preload both
        # libraries if they exist. ld.so will ignore the wrong ELF class.
        CREAM_LIB=""
        LIB_NAME=""
        ;;
esac

if [ -z "$CREAM_LIB" ] && [ "$GAME_ARCH" != unknown ]; then
    echo "Error: no creamlinux library matches the game architecture ($GAME_ARCH)." >&2
    echo "Put an aarch64/x86_64 build in the game folder (or in $GAME_ARCH/)." >&2
    exit 1
fi

if [ "$(uname -m)" = aarch64 ] && [ "$GAME_ARCH" = x86_64 ]; then
    echo "cream.sh: x86-64 game on an ARM host (Steam Frame/FEX)." >&2
    echo "cream.sh: FEX removes LD_PRELOAD, so this launch will not be patched." >&2
    echo "cream.sh: use SmokeAPI for Windows/Proton games instead." >&2
fi

if [ -n "$CREAM_LIB" ]; then
    copy_file "$CREAM_LIB" "$CREAM_TMPDIR/$LIB_NAME"
    PRELOAD_LIBS="$CREAM_TMPDIR/$LIB_NAME"
else
    # Unknown architecture fallback: copy whichever libraries exist.
    PRELOAD_LIBS=""
    if [ -f lib64Creamlinux.so ]; then
        copy_file lib64Creamlinux.so "$CREAM_TMPDIR/lib64Creamlinux.so"
        PRELOAD_LIBS="$CREAM_TMPDIR/lib64Creamlinux.so"
    fi
    if [ -f lib32Creamlinux.so ]; then
        copy_file lib32Creamlinux.so "$CREAM_TMPDIR/lib32Creamlinux.so"
        PRELOAD_LIBS="$PRELOAD_LIBS $CREAM_TMPDIR/lib32Creamlinux.so"
    fi
fi

LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD }$PRELOAD_LIBS $CREAM_TMPDIR/libsteam_api.so" "$@"
EXITCODE=$?
rm -rf "$CREAM_TMPDIR"
exit $EXITCODE
