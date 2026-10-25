/*
 * The Emscripten runtime probes `self.location` and `importScripts` to pick
 * its worker code path. An AudioWorkletGlobalScope has neither of them: it
 * has no `self`, no `location` and no `importScripts`. This module runs
 * before the engine glue and supplies inert stand-ins. The wasm binary is
 * supplied through processorOptions, so the runtime never fetches or
 * imports anything.
 */

interface WorkletScope {
  self?: unknown;
  window?: unknown;
  location?: { href: string };
  importScripts?: (...urls: string[]) => void;
}

const scope = globalThis as unknown as WorkletScope;

// The Emscripten runtime picks its environment by probing `self`, `window`
// and `WorkerGlobalScope`. An AudioWorkletGlobalScope has none of them, so
// the global object stands in for both `self` and `window`. `location` and
// `importScripts` are also missing and have to be supplied inert stand-ins.
if (scope.self === undefined) {
  scope.self = scope;
}

if (scope.window === undefined) {
  scope.window = scope;
}

if (scope.location === undefined) {
  scope.location = { href: import.meta.url };
}

if (typeof scope.importScripts !== 'function') {
  scope.importScripts = () => {
    throw new Error('importScripts is not available in an AudioWorklet');
  };
}
