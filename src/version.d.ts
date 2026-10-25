// The engine version is written by scripts/build-wasm.sh into build/,
// which is not part of the repository. This declaration keeps the type
// checker happy when the wasm has not been built yet.
declare module '*build/version' {
  export const LIBPOPPY_VERSION: string;
}
