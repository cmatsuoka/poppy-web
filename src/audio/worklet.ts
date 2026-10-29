import './worklet-env';
import createPoppyModule, {
  type PoppyModule,
  type PoppyModuleOptions,
} from '../../build/poppy.mjs';
import {
  INITIAL_PANEL_STATE,
  INITIAL_SELECTION,
  PATTERN_COLUMNS,
  VOICE_PARAM,
  type EngineCommand,
  type EngineEvent,
  type PanelState,
  type PatternView,
} from './protocol';
import { SPREAD_INSTRUMENTS, spreadPanQ16 } from './spread';

const BLOCK_FRAMES = 128;
const PANEL_INTERVAL = Math.max(1, Math.round(sampleRate / 20));
/** The number of columns a user pattern holds. */
const USER_PATTERN_COLUMNS = PATTERN_COLUMNS;

interface WorkletOptions {
  processorOptions?: {
    /**
     * The engine binary, already compiled by the main thread. It is
     * instantiated right here, and the engine is ready before the first
     * sound.
     */
    wasmModule?: WebAssembly.Module;
    /**
     * The engine binary as bytes, for the browsers that cannot hand a
     * compiled module over to the worklet. It is compiled in here, and
     * that may only happen from the first render quantum.
     */
    wasmBinary?: ArrayBuffer;
  };
}

/**
 * The module object the Emscripten runtime fills in while it starts up:
 * the exports and the heap views appear on the object that was handed in.
 */
type MutablePoppyModule = Partial<PoppyModule> & PoppyModuleOptions;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PoppyProcessor extends AudioWorkletProcessor {
  private module: PoppyModule | null = null;
  private context = 0;
  private outPtr = 0;
  private samples: Int16Array | null = null;
  private queue: EngineCommand[] = [];
  private panel: PanelState = { ...INITIAL_PANEL_STATE };
  private lastPanel: PanelState = { ...INITIAL_PANEL_STATE };
  private wasmBinary: ArrayBuffer | undefined;
  private building = false;

  private sincePanel = 0;
  private lastColumn = -1;
  /** The scratch buffer the user patterns are written through. */
  private userNotesPtr = 0;

  constructor(options: WorkletOptions) {
    super();

    this.port.onmessage = (event: MessageEvent<EngineCommand>) => {
      const command = event.data;
      if (this.module === null) {
        this.queue.push(command);
        return;
      }
      this.handle(command);
    };

    const wasmModule = options.processorOptions?.wasmModule;
    if (wasmModule !== undefined) {
      this.build(wasmModule);
      return;
    }

    this.wasmBinary = options.processorOptions?.wasmBinary;
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const module = this.module;
    const samples = this.samples;
    const output = outputs[0];

    if (module === null || samples === null || output === undefined) {
      // Without a module from the main thread the engine is built from the
      // first render quantum and not from the constructor: while the
      // worklet global scope is still initialising, the audio thread does
      // not run the tasks the WebAssembly compiler needs, and the
      // compilation never finishes.
      if (!this.building) {
        this.compile();
      }
      if (output !== undefined) {
        for (const channel of output) {
          channel.fill(0);
        }
      }
      return true;
    }

    module._poppy_process(this.context, this.outPtr, BLOCK_FRAMES);

    const left = output[0];
    const right = output[1] ?? output[0];
    if (left === undefined || right === undefined) {
      return true;
    }

    for (let frame = 0; frame < BLOCK_FRAMES; frame += 1) {
      const index = frame * 2;
      left[frame] = (samples[index] ?? 0) / 32768;
      right[frame] = (samples[index + 1] ?? 0) / 32768;
    }

    this.sincePanel += BLOCK_FRAMES;
    this.readPanel();

    // The playhead has to follow the grid closely, so a snapshot is posted
    // as soon as the column moves instead of waiting for the periodic
    // update. The periodic update still carries the slower fields.
    if (this.panel.column !== this.lastColumn) {
      this.lastColumn = this.panel.column;
      this.sincePanel = 0;
      this.postPanel();
    } else if (this.sincePanel >= PANEL_INTERVAL) {
      this.sincePanel = 0;
      this.postPanel();
    }

    return true;
  }

  /**
   * Build the engine from the module the main thread compiled.
   *
   * The instance is created here and the runtime is started synchronously,
   * so the engine is ready as soon as the processor exists. A promise
   * would not do: in an AudioWorkletGlobalScope it is only settled while
   * the context renders, and the context does not render before the first
   * gesture.
   */
  private build(wasmModule: WebAssembly.Module): void {
    this.building = true;

    const module: MutablePoppyModule = {
      instantiateWasm: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance) => WebAssembly.Exports,
      ) => {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        // The exports have to be handed back: the runtime takes the return
        // value of this callback as the exports of the module.
        return receiveInstance(instance);
      },
      onRuntimeInitialized: () => {
        this.attach(module as PoppyModule);
      },
    };

    try {
      // The runtime is already up when the call returns; the promise only
      // carries a failure that happened before the callback ran.
      void createPoppyModule(module).catch((error: unknown) => {
        this.emit({ type: 'error', message: describe(error) });
      });
    } catch (error: unknown) {
      this.emit({ type: 'error', message: describe(error) });
    }
  }

  /**
   * Build the engine from the bytes.
   *
   * The wasm module must not be compiled while the worklet global scope is
   * still initialising: the audio thread cannot run the tasks the compiler
   * needs, and the compilation never finishes. The compile therefore
   * starts from the first render quantum, and `locateFile` keeps the
   * Emscripten runtime from building a `URL` for the binary: an
   * AudioWorkletGlobalScope has no `URL` constructor.
   */
  private compile(): void {
    this.building = true;

    const wasmBinary = this.wasmBinary;
    if (wasmBinary === undefined) {
      this.emit({ type: 'error', message: 'the engine binary is missing' });
      return;
    }

    createPoppyModule({ wasmBinary, locateFile: (path) => path })
      .then((module) => {
        this.attach(module);
      })
      .catch((error: unknown) => {
        this.emit({ type: 'error', message: describe(error) });
      });
  }

  /**
   * Take over the engine the runtime has just started.
   */
  private attach(module: PoppyModule): void {
    const context = module._poppy_create(sampleRate);
    if (context === 0) {
      this.queue.length = 0;
      this.emit({ type: 'error', message: 'could not allocate the engine context' });
      return;
    }

    this.context = context;
    this.module = module;
    this.outPtr = module._malloc(BLOCK_FRAMES * 2 * Int16Array.BYTES_PER_ELEMENT);
    this.samples = new Int16Array(
      module.HEAPU8.buffer,
      this.outPtr,
      BLOCK_FRAMES * 2,
    );
    this.userNotesPtr = module._malloc(
      USER_PATTERN_COLUMNS * Int16Array.BYTES_PER_ELEMENT,
    );

    // The machine comes up with the seventh rhythm key latched. The engine
    // context starts with no key pressed, so the selection is applied here,
    // before the first snapshot goes out: the panel never shows an empty
    // key bed. Selecting starts the transport, so it is stopped again
    // right away.
    module._poppy_select_rhythm(
      this.context,
      INITIAL_SELECTION.bank,
      INITIAL_SELECTION.buttons,
    );
    module._poppy_stop_rhythms(this.context);

    // The user patterns start as copies of the factory rhythms, so the
    // extended mode has something to play before anything is written.
    module._poppy_seed_user_patterns(this.context);

    this.emit({ type: 'ready' });
    this.readPanel();
    this.postPanel();

    for (const command of this.queue) {
      this.handle(command);
    }
    this.queue.length = 0;
  }

  private handle(command: EngineCommand): void {
    const module = this.module;
    if (module === null) {
      return;
    }

    switch (command.type) {
      case 'start': {
        this.readPanel();
        module._poppy_select_rhythm(
          this.context,
          this.panel.bank,
          this.panel.buttons,
        );
        break;
      }
      case 'stop':
        module._poppy_stop_rhythms(this.context);
        break;
      case 'select': {
        this.readPanel();
        const wasRunning = this.panel.running;
        // Use the worklet's own running snapshot: next-cycle scheduling
        // only makes sense while the transport is already running.
        const buttons = command.buttons | (wasRunning ? 0x8000 : 0);
        module._poppy_select_rhythm(this.context, command.bank, buttons);
        if (!wasRunning) {
          module._poppy_stop_rhythms(this.context);
        }
        break;
      }
      case 'trigger':
        module._poppy_trigger(this.context, command.instrument, command.velocity);
        break;
      case 'tempo':
        module._poppy_set_tempo(this.context, command.bpm);
        break;
      case 'volume':
        module._poppy_set_volume(this.context, command.value);
        break;
      case 'balance':
        module._poppy_set_balance(this.context, command.value);
        break;
      case 'instrGain':
        module._poppy_set_instr_gain(
          this.context,
          command.instrument,
          command.value,
        );
        break;
      case 'voiceParam':
        module._poppy_set_voice_param(
          this.context,
          command.instrument,
          command.param,
          command.value,
        );
        break;
      case 'accentGain':
        module._poppy_set_accent_gain(this.context, command.value);
        break;
      case 'spread': {
        // Every instrument that is spread moves to its own place in the
        // stereo field. The instruments that stay in the centre are not
        // touched at all.
        for (const instrument of SPREAD_INSTRUMENTS) {
          module._poppy_set_voice_param(
            this.context,
            instrument,
            VOICE_PARAM.pan,
            spreadPanQ16(command.value, instrument),
          );
        }
        break;
      }
      case 'pattern':
        this.sendPattern(command.rhythm);
        break;
      case 'source':
        module._poppy_set_pattern_source(this.context, command.source);
        break;
      case 'userPattern': {
        // The notes are written into a scratch buffer, so the engine can
        // copy them into the slot itself.
        const heap = module.HEAPU16;
        const base = this.userNotesPtr >> 1;
        for (let index = 0; index < USER_PATTERN_COLUMNS; index += 1) {
          heap[base + index] = command.pattern.notes[index] ?? 0;
        }
        module._poppy_set_user_pattern(
          this.context,
          command.index,
          this.userNotesPtr,
          command.pattern.enableLo,
          command.pattern.enableHi,
          command.pattern.period,
          command.pattern.triplet ? 1 : 0,
        );
        break;
      }
      case 'userPatternRequest':
        this.sendUserPattern(command.index);
        break;
    }

    this.readPanel();
    this.postPanel();
  }

  private readPanel(): void {
    const module = this.module;
    if (module === null) {
      return;
    }

    const pointer = module._poppy_panel_state(this.context);
    const base = pointer >> 2;
    const heap = module.HEAP32;

    const panel = this.panel;
    panel.bank = (heap[base] ?? 0) === 1 ? 1 : 0;
    panel.buttons = (heap[base + 1] ?? 0) & 0x3ff;
    panel.pendingBank = (heap[base + 2] ?? 0) === 1 ? 1 : 0;
    panel.pendingButtons = (heap[base + 3] ?? 0) & 0x3ff;
    panel.pending = (heap[base + 4] ?? 0) !== 0;
    panel.running = (heap[base + 5] ?? 0) !== 0;
    panel.column = (heap[base + 6] ?? 0) & 0x3f;
    panel.flashCount = (heap[base + 7] ?? 0) >>> 0;
    panel.source = (heap[base + 8] ?? 0) === 1 ? 1 : 0;
  }

  private postPanel(): void {
    const panel = this.panel;
    const last = this.lastPanel;

    if (
      panel.bank === last.bank &&
      panel.buttons === last.buttons &&
      panel.pendingBank === last.pendingBank &&
      panel.pendingButtons === last.pendingButtons &&
      panel.pending === last.pending &&
      panel.running === last.running &&
      panel.column === last.column &&
      panel.flashCount === last.flashCount &&
      panel.source === last.source
    ) {
      return;
    }

    last.bank = panel.bank;
    last.buttons = panel.buttons;
    last.pendingBank = panel.pendingBank;
    last.pendingButtons = panel.pendingButtons;
    last.pending = panel.pending;
    last.running = panel.running;
    last.column = panel.column;
    last.flashCount = panel.flashCount;
    last.source = panel.source;

    this.emit({ type: 'panel', state: { ...panel } });
  }

  private sendPattern(rhythm: number): void {
    const module = this.module;
    if (module === null) {
      return;
    }

    // The pattern that is in effect: the factory rhythm in the preset
    // source, the user slot in the user source.
    const pointer = module._poppy_pattern(this.context, rhythm);
    const base = pointer >> 2;
    const heap = module.HEAP32;

    if ((heap[base + 7] ?? 0) === 0) {
      this.emit({
        type: 'pattern',
        view: {
          rhythm,
          notes: [],
          percussion: [],
          enableLo: 0,
          enableHi: 0,
          notesPeriod: 0,
          percussionPeriod: 0,
          triplet: false,
        } satisfies PatternView,
      });
      return;
    }

    const notesPointer = (heap[base] ?? 0) >>> 0;
    const percussionPointer = (heap[base + 1] ?? 0) >>> 0;
    const notesPeriod = heap[base + 4] ?? 0;
    const percussionPeriod = heap[base + 5] ?? 0;
    const u16Base = module.HEAPU16;
    const notesStart = notesPointer >> 1;
    const percussionStart = percussionPointer >> 1;

    const notes: number[] = [];
    for (let index = 0; index < notesPeriod; index += 1) {
      notes.push(u16Base[notesStart + index] ?? 0);
    }

    // A user pattern carries its own percussion lines, so it comes without
    // the shared layer.
    const percussion: number[] = [];
    if (percussionPointer !== 0) {
      for (let index = 0; index < percussionPeriod; index += 1) {
        percussion.push(u16Base[percussionStart + index] ?? 0);
      }
    }

    this.emit({
      type: 'pattern',
      view: {
        rhythm,
        notes,
        percussion,
        enableLo: (heap[base + 2] ?? 0) >>> 0,
        enableHi: (heap[base + 3] ?? 0) >>> 0,
        notesPeriod,
        percussionPeriod: percussionPointer === 0 ? 0 : percussionPeriod,
        triplet: (heap[base + 6] ?? 0) !== 0,
      } satisfies PatternView,
    });
  }

  /** Read a user slot back, for the editor and for the saved patterns. */
  private sendUserPattern(slot: number): void {
    const module = this.module;
    if (module === null) {
      return;
    }

    const pointer = module._poppy_user_pattern(this.context, slot);
    const base = pointer >> 2;
    const heap = module.HEAP32;

    if ((heap[base + 7] ?? 0) === 0) {
      this.emit({
        type: 'userPattern',
        index: slot,
        pattern: {
          notes: new Array<number>(USER_PATTERN_COLUMNS).fill(0),
          enableLo: 0,
          enableHi: 0,
          period: USER_PATTERN_COLUMNS,
          triplet: false,
        },
      });
      return;
    }

    const notesPointer = (heap[base] ?? 0) >>> 0;
    const notesPeriod = heap[base + 4] ?? 0;
    const u16Base = module.HEAPU16;
    const notesStart = notesPointer >> 1;

    const notes: number[] = new Array<number>(USER_PATTERN_COLUMNS).fill(0);
    for (let index = 0; index < notesPeriod; index += 1) {
      notes[index] = u16Base[notesStart + index] ?? 0;
    }

    this.emit({
      type: 'userPattern',
      index: slot,
      pattern: {
        notes,
        enableLo: (heap[base + 2] ?? 0) >>> 0,
        enableHi: (heap[base + 3] ?? 0) >>> 0,
        period: notesPeriod,
        triplet: (heap[base + 6] ?? 0) !== 0,
      },
    });
  }

  private emit(event: EngineEvent): void {
    this.port.postMessage(event);
  }
}

registerProcessor('poppy-processor', PoppyProcessor);
