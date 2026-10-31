declare module '*poppy.mjs' {
  export interface PoppyModule {
    HEAPU8: Uint8Array;
    HEAPU16: Uint16Array;
    HEAP32: Int32Array;

    _malloc(size: number): number;
    _free(ptr: number): void;
    _poppy_version(): number;
    _poppy_instrument_count(): number;
    _poppy_rhythm_count(): number;
    _poppy_create(sampleRate: number): number;
    _poppy_destroy(ctx: number): void;
    _poppy_reset(ctx: number): void;
    _poppy_process(ctx: number, outPtr: number, frames: number): void;
    _poppy_trigger(ctx: number, instrument: number, velocity: number): void;
    _poppy_select_rhythm(ctx: number, bank: number, buttons: number): void;
    _poppy_stop_rhythms(ctx: number): void;
    _poppy_set_tempo(ctx: number, bpm: number): void;
    _poppy_set_volume(ctx: number, q16: number): void;
    _poppy_set_balance(ctx: number, q16: number): void;
    _poppy_set_instr_gain(ctx: number, instrument: number, q16: number): void;
    _poppy_set_voice_param(
      ctx: number,
      instrument: number,
      param: number,
      value: number,
    ): number;
    _poppy_set_accent_gain(ctx: number, q16: number): void;
    _poppy_panel_state(ctx: number): number;
    _poppy_factory_pattern(rhythm: number): number;
    _poppy_pattern(ctx: number, rhythm: number): number;
    _poppy_set_pattern_source(ctx: number, source: number): void;
    _poppy_get_pattern_source(ctx: number): number;
    _poppy_seed_user_patterns(ctx: number): void;
    _poppy_set_user_pattern(
      ctx: number,
      index: number,
      notesPtr: number,
      timesig: number,
      period: number,
    ): number;
    _poppy_user_pattern(ctx: number, index: number): number;
    _poppy_default_user_pattern(index: number): number;
  }

  export interface PoppyModuleOptions {
    wasmBinary?: ArrayBuffer;
    noInitialRun?: boolean;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    locateFile?: (path: string) => string;
    /**
     * Take over the instantiation of the wasm module. The callback gets
     * the imports of the module and hands the instance back to the
     * runtime. It may be called synchronously, and the exports of the
     * instance have to be returned: the runtime takes them from there.
     */
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance) => WebAssembly.Exports,
    ) => WebAssembly.Exports;
    /**
     * Called when the runtime is up and the C constructors have run. The
     * module object that was handed in carries the exports and the heap
     * views from that moment on.
     */
    onRuntimeInitialized?: () => void;
  }

  const createPoppyModule: (
    options?: PoppyModuleOptions,
  ) => Promise<PoppyModule>;
  export default createPoppyModule;
}
