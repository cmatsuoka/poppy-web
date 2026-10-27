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
not committed. The pinned upstream commit is set in that script. The same
script writes `build/version.ts` with the version of the library it just
built, and the panel shows that version next to the engine's name.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Start or stop the machine |
| `1` … `9`, `0` | Press rhythm key 1 … 10 |
| `A` / `B` | Select rhythm bank A or B |
| `E` | Preset rhythms or user patterns |

## Checks

```sh
npm run typecheck    # tsc --noEmit
npm run test:glue    # native check of the wasm glue (needs the vendored library)
```

## Secure context

The sound engine runs in an `AudioWorklet`, and browsers only expose the
worklet in a **secure context**. `http://localhost:5173` counts as secure,
but the LAN address Vite prints with `--host` does not, and the app will
report

> the Web Audio worklet needs a secure context

instead of playing. Use the HTTPS dev server for phones and other machines:

```sh
npm run dev:secure   # https://<lan-address>:5173, self-signed certificate
```

The browser will warn about the self-signed certificate; accept it and the
worklet becomes available.
