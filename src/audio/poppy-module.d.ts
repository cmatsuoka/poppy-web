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
    _poppy_panel_state(ctx: number): number;
    _poppy_factory_pattern(rhythm: number): number;
  }

  export interface PoppyModuleOptions {
    wasmBinary?: ArrayBuffer;
    noInitialRun?: boolean;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
    locateFile?: (path: string) => string;
  }

  const createPoppyModule: (
    options?: PoppyModuleOptions,
  ) => Promise<PoppyModule>;
  export default createPoppyModule;
}
