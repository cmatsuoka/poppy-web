import './worklet-env';
import createPoppyModule, { type PoppyModule } from '../../build/poppy.mjs';
import {
  INITIAL_PANEL_STATE,
  type EngineCommand,
  type EngineEvent,
  type PanelState,
  type PatternView,
} from './protocol';

const BLOCK_FRAMES = 128;
const PANEL_INTERVAL = Math.max(1, Math.round(sampleRate / 20));

interface WorkletOptions {
  processorOptions?: {
    wasmBinary?: ArrayBuffer;
  };
}

class PoppyProcessor extends AudioWorkletProcessor {
  private module: PoppyModule | null = null;
  private context = 0;
  private outPtr = 0;
  private samples: Int16Array | null = null;
  private queue: EngineCommand[] = [];
  private panel: PanelState = { ...INITIAL_PANEL_STATE };
  private lastPanel: PanelState = { ...INITIAL_PANEL_STATE };

  private sincePanel = 0;
  private lastFlash = -1;

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

    const wasmBinary = options.processorOptions?.wasmBinary;
    createPoppyModule({ wasmBinary })
      .then((module) => {
        this.module = module;
        this.context = module._poppy_create(sampleRate);
        if (this.context === 0) {
          throw new Error('could not allocate the engine context');
        }

        this.outPtr = module._malloc(BLOCK_FRAMES * 2 * Int16Array.BYTES_PER_ELEMENT);
        this.samples = new Int16Array(
          module.HEAPU8.buffer,
          this.outPtr,
          BLOCK_FRAMES * 2,
        );

        this.emit({ type: 'ready' });
        this.readPanel();
        this.postPanel();

        for (const command of this.queue) {
          this.handle(command);
        }
        this.queue.length = 0;
      })
      .catch((error: unknown) => {
        this.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
  ): boolean {
    const module = this.module;
    const samples = this.samples;
    const output = outputs[0];

    if (module === null || samples === null || output === undefined) {
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
    if (this.sincePanel >= PANEL_INTERVAL) {
      this.sincePanel = 0;
      this.readPanel();
      this.postPanel();
    }

    return true;
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
      case 'pattern':
        this.sendPattern(command.rhythm);
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
      panel.flashCount === last.flashCount
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
    this.lastFlash = panel.flashCount;

    this.emit({ type: 'panel', state: { ...panel } });
  }

  private sendPattern(rhythm: number): void {
    const module = this.module;
    if (module === null) {
      return;
    }

    const pointer = module._poppy_factory_pattern(rhythm);
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

    const percussion: number[] = [];
    for (let index = 0; index < percussionPeriod; index += 1) {
      percussion.push(u16Base[percussionStart + index] ?? 0);
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
        percussionPeriod,
        triplet: (heap[base + 6] ?? 0) !== 0,
      } satisfies PatternView,
    });
  }

  private emit(event: EngineEvent): void {
    this.port.postMessage(event);
  }
}

registerProcessor('poppy-processor', PoppyProcessor);
