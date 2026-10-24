import wasmUrl from '../../build/poppy.wasm?url';
import workletUrl from './worklet.ts?worker&url';
import {
  INITIAL_PANEL_STATE,
  type Bank,
  type EngineCommand,
  type EngineEvent,
  type PanelState,
  type PatternView,
} from './protocol';

const Q16 = 65536;

interface Settings {
  tempo: number;
  volume: number;
  balance: number;
  instrGain: number[];
}

function defaultSettings(): Settings {
  const instrGain = Array.from({ length: 15 }, () => Q16);
  instrGain[12] = Q16 / 2;
  instrGain[13] = Q16 / 2;
  instrGain[14] = Q16 / 2;
  return {
    tempo: 120,
    // Mid-position on the volume fader maps to panel value 2.0, which the
    // engine turns into a master gain of 1.0 via its fixed 0.5 factor.
    volume: 2 * Q16,
    balance: Q16 / 2,
    instrGain,
  };
}

export class PoppyEngine {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private panelState: PanelState = { ...INITIAL_PANEL_STATE };
  private settings = defaultSettings();
  private panelListeners = new Set<(state: PanelState) => void>();
  private errorListeners = new Set<(message: string) => void>();
  private pending: EngineCommand[] = [];
  private patternRequests = new Map<
    number,
    { resolve: (view: PatternView) => void; reject: (reason: Error) => void }
  >();

  get panel(): PanelState {
    return this.panelState;
  }

  get running(): boolean {
    return this.panelState.running;
  }

  onPanel(listener: (state: PanelState) => void): () => void {
    this.panelListeners.add(listener);
    return () => {
      this.panelListeners.delete(listener);
    };
  }

  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    await this.ensure();
    this.post({ type: 'start' });
  }

  stop(): void {
    this.post({ type: 'stop' });
  }

  select(bank: Bank, buttons: number): void {
    this.post({ type: 'select', bank, buttons });
    this.wake();
  }

  trigger(instrument: number, down: boolean): void {
    this.post({
      type: 'trigger',
      instrument,
      velocity: down ? 127 : 0,
    });
    this.wake();
  }

  setTempo(bpm: number): void {
    this.settings.tempo = Math.min(240, Math.max(1, Math.round(bpm)));
    this.post({ type: 'tempo', bpm: this.settings.tempo });
    this.wake();
  }

  setVolume(value: number): void {
    this.settings.volume = value;
    this.post({ type: 'volume', value });
    this.wake();
  }

  setBalance(value: number): void {
    this.settings.balance = value;
    this.post({ type: 'balance', value });
    this.wake();
  }

  setInstrumentGain(instrument: number, value: number): void {
    if (instrument < 0 || instrument >= this.settings.instrGain.length) {
      return;
    }
    this.settings.instrGain[instrument] = value;
    this.post({ type: 'instrGain', instrument, value });
    this.wake();
  }

  getPattern(rhythm: number): Promise<PatternView> {
    return new Promise((resolve, reject) => {
      this.patternRequests.set(rhythm, { resolve, reject });
      this.post({ type: 'pattern', rhythm });
      this.wake();
    });
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    if (context !== null) {
      await context.close();
    }
  }

  private async ensure(): Promise<void> {
    if (this.node !== null) {
      await this.context?.resume();
      return;
    }

    if (this.starting !== null) {
      return this.starting;
    }

    this.starting = (async () => {
      const context = new AudioContext({ latencyHint: 'interactive' });
      try {
        const [bytes] = await Promise.all([
          fetch(wasmUrl).then(async (response) => {
            if (!response.ok) {
              throw new Error(`wasm request failed (${response.status})`);
            }
            return response.arrayBuffer();
          }),
          context.audioWorklet.addModule(workletUrl),
        ]);

        const node = new AudioWorkletNode(context, 'poppy-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { wasmBinary: bytes },
        });

        node.port.onmessage = (event: MessageEvent<EngineEvent>) => {
          this.handleEvent(event.data);
        };
        node.addEventListener('processorerror', () => {
          this.emitError('the audio processor stopped unexpectedly');
        });

        node.connect(context.destination);
        this.context = context;
        this.node = node;
        this.applySettings();
        for (const command of this.pending) {
          node.port.postMessage(command);
        }
        this.pending.length = 0;
        await context.resume();
      } catch (error) {
        await context.close();
        throw error;
      }
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private applySettings(): void {
    this.post({ type: 'tempo', bpm: this.settings.tempo });
    this.post({ type: 'volume', value: this.settings.volume });
    this.post({ type: 'balance', value: this.settings.balance });
    this.settings.instrGain.forEach((value, instrument) => {
      this.post({ type: 'instrGain', instrument, value });
    });
  }

  private post(command: EngineCommand): void {
    if (this.node !== null) {
      this.node.port.postMessage(command);
      return;
    }
    this.pending.push(command);
  }

  private wake(): void {
    void this.ensure().catch((error: unknown) => {
      this.emitError(error instanceof Error ? error.message : String(error));
    });
  }

  private handleEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'ready':
        break;
      case 'panel':
        this.panelState = event.state;
        for (const listener of this.panelListeners) {
          listener(this.panelState);
        }
        break;
      case 'pattern': {
        const handlers = this.patternRequests.get(event.view.rhythm);
        if (handlers !== undefined) {
          this.patternRequests.delete(event.view.rhythm);
          handlers.resolve(event.view);
        }
        break;
      }
      case 'error': {
        this.emitError(event.message);
        this.rejectAllPatternRequests(new Error(event.message));
        break;
      }
    }
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) {
      listener(message);
    }
  }

  private rejectAllPatternRequests(reason: Error): void {
    for (const handlers of this.patternRequests.values()) {
      handlers.reject(reason);
    }
    this.patternRequests.clear();
  }
}
