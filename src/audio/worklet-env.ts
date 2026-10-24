/*
 * The Emscripten runtime probes `self.location` and `importScripts` to pick
 * its worker code path. Neither exists in an AudioWorkletGlobalScope, so this
 * module runs before the engine glue and supplies inert stand-ins. The wasm
 * binary is supplied through processorOptions, so the runtime never fetches
 * or imports anything.
 */

interface WorkletScope {
  location?: { href: string };
  importScripts?: (...urls: string[]) => void;
}

const scope = globalThis as unknown as WorkletScope;

if (scope.location === undefined) {
  scope.location = { href: import.meta.url };
}

if (typeof scope.importScripts !== 'function') {
  scope.importScripts = () => {
    throw new Error('importScripts is not available in an AudioWorklet');
  };
}
