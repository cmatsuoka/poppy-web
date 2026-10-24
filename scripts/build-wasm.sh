#!/usr/bin/env bash
#
# Fetch the pinned upstream engine and build the wasm glue.
#
# The upstream checkout lives in vendor/libpoppy and is never committed.
# Update LIBPOPPY_COMMIT deliberately: the API is still moving.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBPOPPY_REPO="${LIBPOPPY_REPO:-https://github.com/cmatsuoka/libpoppy.git}"
LIBPOPPY_COMMIT="${LIBPOPPY_COMMIT:-ac4e6af7711866f660e7ac634d54f7ebea3e8c43}"
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

if [ ! -d "$LIBPOPPY_DIR/.git" ]; then
    mkdir -p "$(dirname "$LIBPOPPY_DIR")"
    git clone "$LIBPOPPY_REPO" "$LIBPOPPY_DIR"
fi

git -C "$LIBPOPPY_DIR" fetch --depth 1 origin "$LIBPOPPY_COMMIT"
git -C "$LIBPOPPY_DIR" checkout --detach "$LIBPOPPY_COMMIT"

mkdir -p "$OUT_DIR"

EXPORTED_FUNCTIONS='["_malloc","_free","_poppy_version","_poppy_instrument_count","_poppy_rhythm_count","_poppy_create","_poppy_destroy","_poppy_reset","_poppy_process","_poppy_trigger","_poppy_select_rhythm","_poppy_stop_rhythms","_poppy_set_tempo","_poppy_set_volume","_poppy_set_balance","_poppy_set_instr_gain","_poppy_panel_state","_poppy_factory_pattern"]'

# shellcheck disable=SC2086
"$EMCC" \
    "$ROOT/wasm/poppy_wasm.c" \
    "$LIBPOPPY_DIR"/src/*.c \
    -I"$LIBPOPPY_DIR/include" \
    -I"$LIBPOPPY_DIR/src" \
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

echo "built $OUT_DIR/poppy.mjs and $OUT_DIR/poppy.wasm"
