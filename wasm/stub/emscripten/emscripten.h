/*
 * A stand-in for the Emscripten header, so the wasm glue can be compiled
 * with the host compiler for the native check in wasm/test_glue.c.
 *
 * Only the pieces the glue uses are here. The real header is used by the
 * wasm build; this one is not on its include path.
 */
#ifndef EMSCRIPTEN_STUB_H
#define EMSCRIPTEN_STUB_H

#define EMSCRIPTEN_KEEPALIVE __attribute__((used))

#endif
