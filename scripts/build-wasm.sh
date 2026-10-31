#!/usr/bin/env bash
#
# Fetch the engine and build the wasm glue.
#
# The engine is libpoppy. Its sources are taken from LIBPOPPY_SOURCE and
# copied into LIBPOPPY_DIR, where the local patches are applied. The
# source tree is never written to: it may be a checkout that belongs to
# somebody else.
#
# The source is the sibling checkout of the library when there is one
# (../minipops), because it carries the newest API. Otherwise the pinned
# commit is fetched into vendor/libpoppy-src. Update LIBPOPPY_COMMIT
# deliberately: the API is still moving.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBPOPPY_REPO="${LIBPOPPY_REPO:-https://github.com/cmatsuoka/libpoppy.git}"
LIBPOPPY_COMMIT="${LIBPOPPY_COMMIT:-2b929a867f2c943d1efe12e9d59d658e8175435a}"
# The checkout of the library that carries the newest API.
LIBPOPPY_SIBLING="${LIBPOPPY_SIBLING:-$ROOT/../minipops}"
# The pristine sources the build is made from.
LIBPOPPY_SOURCE="${LIBPOPPY_SOURCE:-}"
# The sources the build actually compiles: a copy of the sources above with
# the local patches applied.
LIBPOPPY_DIR="${LIBPOPPY_DIR:-$ROOT/vendor/libpoppy}"
EMCC="${EMCC:-emcc}"
OUT_DIR="$ROOT/build"

if ! command -v "$EMCC" >/dev/null 2>&1; then
    cat >&2 <<'EOF'
error: emcc not found.

Install Emscripten (emsdk) and put it on PATH, or set EMCC=/path/to/emcc:

  git clone https://github.com/emscripten-core/emsdk.git
  cd emsdk && ./emsdk install latest && ./emsdk activate latest
  source ./emsdk_env.sh
EOF
    exit 1
fi

# Where the pristine sources come from.
if [ -z "$LIBPOPPY_SOURCE" ]; then
    if [ -f "$LIBPOPPY_SIBLING/include/mp7.h" ]; then
        # The sibling checkout is the working copy of the library, and it
        # carries the API this panel is written against.
        LIBPOPPY_SOURCE="$LIBPOPPY_SIBLING"
    else
        LIBPOPPY_SOURCE="$ROOT/vendor/libpoppy-src"
    fi
fi

if [ ! -f "$LIBPOPPY_SOURCE/include/mp7.h" ]; then
    # No local checkout: fetch the pinned commit.
    if [ ! -d "$LIBPOPPY_SOURCE/.git" ]; then
        mkdir -p "$(dirname "$LIBPOPPY_SOURCE")"
        git clone "$LIBPOPPY_REPO" "$LIBPOPPY_SOURCE"
    fi

    if ! git -C "$LIBPOPPY_SOURCE" fetch --depth 1 origin "$LIBPOPPY_COMMIT"; then
        cat >&2 <<EOF
error: the pinned engine commit could not be fetched.

  $LIBPOPPY_COMMIT

The commit has to be in the upstream repository:

  git -C $LIBPOPPY_SOURCE fetch origin $LIBPOPPY_COMMIT

A local checkout of the library can be used instead:

  LIBPOPPY_SOURCE=/path/to/libpoppy npm run build:wasm
EOF
        exit 1
    fi
    # The checkout is forced: the tree carries the local patches below, and
    # a pinned commit that moves on would otherwise run into them.
    git -C "$LIBPOPPY_SOURCE" checkout --force --detach "$LIBPOPPY_COMMIT"
fi

if [ ! -d "$LIBPOPPY_SOURCE/src" ]; then
    echo "error: the library sources are missing: $LIBPOPPY_SOURCE" >&2
    exit 1
fi

# The build compiles a copy of the sources, so the checkout the sources
# come from stays untouched.
rm -rf "$LIBPOPPY_DIR"
mkdir -p "$LIBPOPPY_DIR"
cp -R "$LIBPOPPY_SOURCE/include" "$LIBPOPPY_DIR/include"
cp -R "$LIBPOPPY_SOURCE/src" "$LIBPOPPY_DIR/src"
if [ -f "$LIBPOPPY_SOURCE/LICENSE" ]; then
    cp "$LIBPOPPY_SOURCE/LICENSE" "$LIBPOPPY_DIR/LICENSE"
fi

# The copy is a repository of its own, so the patches can be applied with
# git: git apply is strict about the context of a hunk, so a patch that
# does not fit the engine is an error and not a silent change.
(
    cd "$LIBPOPPY_DIR"
    git init -q .
    git add -A
    git -c user.email=build@poppy-web -c user.name=poppy-web \
        commit -q -m "the engine sources, as they were fetched"
)

# The local patches. They are applied to the copy above, so every machine
# builds the same engine. A patch that does not apply is an error: it has
# to be rebased on the pinned commit first.
PATCH_DIR="$ROOT/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch in "$PATCH_DIR"/*.patch; do
        [ -e "$patch" ] || continue
        name="$(basename "$patch")"
        if ! git -C "$LIBPOPPY_DIR" apply -p1 --check "$patch" >/dev/null 2>&1; then
            echo "error: the patch does not apply to the pinned engine: $name" >&2
            echo "       rebase it on $LIBPOPPY_COMMIT and try again" >&2
            exit 1
        fi
        git -C "$LIBPOPPY_DIR" apply -p1 "$patch"
        echo "applied $name"
    done
fi

mkdir -p "$OUT_DIR"

# The version of the engine that was just taken, so the panel can name the
# library it is running.
VERSION_HEADER="$LIBPOPPY_DIR/include/mp7.h"

read_version() {
    awk -v key="$1" '$1 == "#define" && $2 == key { print $3; exit }' "$VERSION_HEADER"
}

VERSION_MAJOR="$(read_version MP7_VERSION_MAJOR)"
VERSION_MINOR="$(read_version MP7_VERSION_MINOR)"
VERSION_PATCH="$(read_version MP7_VERSION_PATCH)"

if [ -z "$VERSION_MAJOR" ] || [ -z "$VERSION_MINOR" ] || [ -z "$VERSION_PATCH" ]; then
    echo "error: could not read the library version from $VERSION_HEADER" >&2
    exit 1
fi

cat > "$OUT_DIR/version.ts" <<EOF
// Generated by scripts/build-wasm.sh - do not edit.
export const LIBPOPPY_VERSION = '${VERSION_MAJOR}.${VERSION_MINOR}.${VERSION_PATCH}';
EOF

EXPORTED_FUNCTIONS='["_malloc","_free","_poppy_version","_poppy_instrument_count","_poppy_rhythm_count","_poppy_create","_poppy_destroy","_poppy_reset","_poppy_process","_poppy_trigger","_poppy_select_rhythm","_poppy_stop_rhythms","_poppy_set_tempo","_poppy_set_volume","_poppy_set_balance","_poppy_set_instr_gain","_poppy_set_voice_param","_poppy_set_accent_gain","_poppy_panel_state","_poppy_factory_pattern","_poppy_pattern","_poppy_set_pattern_source","_poppy_get_pattern_source","_poppy_seed_user_patterns","_poppy_set_user_pattern","_poppy_user_pattern"]'

# The extended build of the engine: it carries the 20 user pattern slots and
# the switch that points the sequencer at them. The panel's extended mode
# needs them, so the macro is always on here.
LIBPOPPY_DEFS='-DLIBPOPPY_EXTRA'

# shellcheck disable=SC2086
"$EMCC" \
    "$ROOT/wasm/poppy_wasm.c" \
    "$LIBPOPPY_DIR"/src/*.c \
    -I"$LIBPOPPY_DIR/include" \
    -I"$LIBPOPPY_DIR/src" \
    $LIBPOPPY_DEFS \
    -std=c99 -O3 \
    --no-entry \
    -o "$OUT_DIR/poppy.mjs" \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=createPoppyModule \
    -sENVIRONMENT=worker \
    -sFILESYSTEM=0 \
    -sMALLOC=emmalloc \
    -sINITIAL_MEMORY=16777216 \
    -sSTACK_SIZE=131072 \
    -sASSERTIONS=1 \
    -sEXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAP32

echo "built $OUT_DIR/poppy.mjs and $OUT_DIR/poppy.wasm (libpoppy ${VERSION_MAJOR}.${VERSION_MINOR}.${VERSION_PATCH})"
