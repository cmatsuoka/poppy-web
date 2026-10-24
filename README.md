# poppy-web

A browser recreation of a 1970s Japanese preset rhythm unit. The sound
engine is [libpoppy](https://github.com/cmatsuoka/libpoppy), a small
integer-only C library compiled to WebAssembly. Audio is generated entirely
by libpoppy, no samples are used.

## Run it

Requirements: Node 20+, npm, and Emscripten (`emcc`) on `PATH` for the
wasm build.

```sh
npm install
npm run build:wasm   # fetch pinned libpoppy, compile wasm
npm run dev          # http://localhost:5173
```

Production build:

```sh
npm run build
npm run preview
```

`vendor/libpoppy` is fetched into place by `scripts/build-wasm.sh` and is
not committed. The pinned upstream commit is set in that script.

