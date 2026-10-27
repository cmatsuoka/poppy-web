#!/usr/bin/env bash
#
# The native check for the wasm glue.
#
# The glue is plain C, so it is compiled here with the host compiler
# against the same library sources the wasm build uses. The check needs the
# vendored library, so run scripts/build-wasm.sh first.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBPOPPY_DIR="${LIBPOPPY_DIR:-$ROOT/vendor/libpoppy}"
CC="${CC:-cc}"
BUILD_DIR="${BUILD_DIR:-$ROOT/build}"

if [ ! -d "$LIBPOPPY_DIR/src" ]; then
    cat >&2 <<'EOF'
error: the vendored library is missing.

Run scripts/build-wasm.sh first: it fetches the pinned libpoppy.
EOF
    exit 1
fi

if ! command -v "$CC" >/dev/null 2>&1; then
    echo "error: no C compiler found (set CC)." >&2
    exit 1
fi

mkdir -p "$BUILD_DIR"

# The glue hands its pointers out as int32, which is what wasm wants. A
# 64-bit host build needs the addresses to fit into an int32, so the binary
# is linked non-PIE.
"$CC" -std=c99 -O2 -no-pie -DLIBPOPPY_EXTRA \
    -I"$ROOT/wasm/stub" \
    -I"$LIBPOPPY_DIR/include" \
    -I"$LIBPOPPY_DIR/src" \
    -I"$ROOT/wasm" \
    "$ROOT"/vendor/libpoppy/src/*.c \
    "$ROOT/wasm/test_glue.c" \
    -o "$BUILD_DIR/test_glue"

"$BUILD_DIR/test_glue"
