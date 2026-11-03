import wasmUrl from '../../build/poppy.wasm?url';
import workletUrl from './worklet.ts?worker&url';
import {
  INITIAL_PANEL_STATE,
  type Bank,
  type EngineCommand,
  type EngineEvent,
  type PanelState,
  type PatternSource,
  type PatternView,
  type UserPattern,
} from './protocol';

const Q16 = 65536;
const FALLBACK_SAMPLE_RATE = 48000;

/**
 * The peak of the constant noise floor added to the output.
 *
 * This is a workaround for certain USB speakers, the JBL Quantum Duo in
 * particular: they keep a noise gate on their input and cut quiet passages,
 * or a soft instrument that plays alone. A constant, inaudible noise floor keeps the
 * gate open. Uniform noise at this peak has an RMS of about 0.001, which is
 * -60 dBFS: far below anything the machine plays, and below the hearing
 * threshold at any sane listening volume. The noise is deliberate; do not
 * remove it without checking the gate bug on those speakers.
 */
const GATE_NOISE_AMPLITUDE = 0.00173;
const GATE_NOISE_SECONDS = 2;

interface Settings {
  tempo: number;
  volume: number;
  balance: number;
  instrGain: number[];
  /** The gain an accented column is played at, Q16. */
  accentGain: number;
  /** The spread of the instruments over the stereo field, -1 to 1. */
  spread: number;
  /** The place of every instrument in the stereo field, Q16. */
  instrPan: number[];
  /** The decay of the snare 1, as a multiplier of the factory decay, Q16. */
  snare1Decay: number;
  /** The center of the band-pass of the snare 1, in Hz. */
  snare1Cutoff: number;
  /** The center of the band-pass of the hi-hat, in Hz. */
  hihatCutoff: number;
}

/**
 * The Web Audio worklet is only exposed in a secure context, and a few
 * browsers still hide it behind a flag. Check for that before the engine
 * tries to build a node, so the panel can say what is actually wrong
 * instead of failing with a bare "cannot read addModule".
 */
function workletUnavailableReason(): string | null {
  if (typeof AudioWorkletNode === 'undefined') {
    return 'this browser does not support the Web Audio worklet';
  }
  if (!window.isSecureContext) {
    return 'the Web Audio worklet needs a secure context — open the app on http://localhost:5173 or over HTTPS';
  }
  return null;
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
    // The engine's own accent gain: 1.2 times the level of a column that
    // is not accented.
    accentGain: Math.round((6 * Q16) / 5),
    // The instruments stand in the center of the stereo field, the way
    // the engine comes up.
    spread: 0,
    // Every instrument stands in the center of the stereo field.
    instrPan: Array.from({ length: 15 }, () => Q16 / 2),
    // The factory decay of the snare 1 and the factory cut-offs.
    snare1Decay: Q16,
    snare1Cutoff: 5500,
    hihatCutoff: 10000,
  };
}

export class PoppyEngine {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gateNoise: AudioBufferSourceNode | null = null;
  private starting: Promise<void> | null = null;
  private panelState: PanelState = { ...INITIAL_PANEL_STATE };
  private settings = defaultSettings();
  private panelListeners = new Set<(state: PanelState) => void>();
  private errorListeners = new Set<(message: string) => void>();
  private pending: EngineCommand[] = [];
  private patternRequests = new Map<
    string,
    { resolve: (view: PatternView) => void; reject: (reason: Error) => void }
  >();
  private patternCache = new Map<string, PatternView>();
  private patternPending = new Map<string, Promise<PatternView>>();
  private userPatternRequests = new Map<
    number,
    { resolve: (pattern: UserPattern) => void; reject: (reason: Error) => void }
  >();
  private userPatternPending = new Map<number, Promise<UserPattern>>();
  // A missing worklet is not something a retry can fix, so the failure is
  // latched and the engine stops trying to build a node.
  private fatal: Error | null = null;

  constructor() {
    const unsupported = workletUnavailableReason();
    if (unsupported !== null) {
      this.fatal = new Error(unsupported);
    }
  }

  /**
   * Why the engine cannot run at all, if that is the case. The panel shows
   * this before anything is pressed, so a browser or an address that can
   * never play is obvious right away.
   */
  get unavailable(): string | null {
    return this.fatal?.message ?? null;
  }

  get panel(): PanelState {
    return this.panelState;
  }

  get running(): boolean {
    return this.panelState.running;
  }

  get tempo(): number {
    return this.settings.tempo;
  }

  /** The rate the engine renders at. */
  get sampleRate(): number {
    return this.context?.sampleRate ?? FALLBACK_SAMPLE_RATE;
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
    // The context may still be held back by the autoplay policy; the resume
    // promise then stays pending until a gesture unlocks the context.
    void this.resume();
  }

  /**
   * Build the audio graph while the page is loading.
   *
   * Creating the context, loading the worklet and compiling the engine
   * binary takes a moment, and none of it has to wait for the user: the
   * first press on START then only has to wake the context up. The engine
   * still works without this call, the first command would just build
   * everything first.
   */
  async init(): Promise<void> {
    try {
      await this.ensure();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.emitError(reason.message);
      this.rejectAllPatternRequests(reason);
    }
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

  /**
   * Instrument gains range from 0.0x to 2.0x.
   *
   * 1.0x corresponds to the default levels in classic mode (Q16 65536).
   */
  setInstrumentGain(instrument: number, value: number): void {
    if (instrument < 0 || instrument >= this.settings.instrGain.length) {
      return;
    }
    this.settings.instrGain[instrument] = value;
    this.post({ type: 'instrGain', instrument, value });
    this.wake();
  }

  /**
   * The place of an instrument in the stereo field, Q16.
   *
   * Zero is hard left, 65536 is hard right and 32768 - the place every
   * instrument comes up in - is the center of the field.
   */
  setInstrumentPan(instrument: number, value: number): void {
    if (instrument < 0 || instrument >= this.settings.instrPan.length) {
      return;
    }
    this.settings.instrPan[instrument] = value;
    this.post({ type: 'instrPan', instrument, value });
    this.wake();
  }

  /**
   * The decay of the snare 1, as a multiplier of the factory decay, Q16.
   *
   * 65536 is the factory decay: the snare rings as long as it does on the
   * machine.
   */
  setSnare1Decay(value: number): void {
    this.settings.snare1Decay = value;
    this.post({ type: 'snare1Decay', value });
    this.wake();
  }

  /** The center of the band-pass of the snare 1, in Hz. */
  setSnare1Cutoff(value: number): void {
    this.settings.snare1Cutoff = value;
    this.post({ type: 'snare1Cutoff', value });
    this.wake();
  }

  /** The center of the band-pass of the hi-hat, in Hz. */
  setHihatCutoff(value: number): void {
    this.settings.hihatCutoff = value;
    this.post({ type: 'hihatCutoff', value });
    this.wake();
  }

  /**
   * The gain an accented column of a user pattern is played at, Q16.
   * 65536 is 1.0, and the engine starts at 1.2.
   */
  setAccentGain(value: number): void {
    this.settings.accentGain = value;
    this.post({ type: 'accentGain', value });
    this.wake();
  }

  /**
   * Spread the instruments over the stereo field.
   *
   * The knob stands between -1 and 1: at zero every instrument is in the
   * center of the field, at one every instrument stands as far to its own
   * side as it goes, and below zero the whole field is mirrored. The
   * instruments that stay in the center are not touched.
   */
  setStereoSpread(value: number): void {
    const spread = Math.min(1, Math.max(-1, value));
    this.settings.spread = spread;
    this.post({ type: 'spread', value: spread });
    this.wake();
  }

  /**
   * The view of a selection: the grid of the cycle, every voice of it.
   *
   * The engine composes the selection, so the panel does not have to know
   * that the notes are OR-ed together, that the masks are AND-ed, or that
   * the shared percussion layer plays with every factory rhythm. The same
   * call serves a selection of one rhythm and a selection of several.
   */
  getPattern(bank: Bank, buttons: number): Promise<PatternView> {
    const key = `${bank}:${buttons}`;
    const cached = this.patternCache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const inflight = this.patternPending.get(key);
    if (inflight !== undefined) {
      return inflight;
    }

    const request = new Promise<PatternView>((resolve, reject) => {
      this.patternRequests.set(key, { resolve, reject });
      this.post({ type: 'pattern', bank, buttons });
      this.wake();
    })
      .then((view) => {
        this.patternCache.set(key, view);
        this.patternPending.delete(key);
        return view;
      })
      .catch((error: unknown) => {
        this.patternPending.delete(key);
        throw error;
      });

    this.patternPending.set(key, request);
    return request;
  }

  /**
   * Point the sequencer at the factory rhythms or at the user slots.
   *
   * The switch is immediate: the selection keeps its meaning and is read
   * against the other set of patterns.
   */
  setSource(source: PatternSource): void {
    this.post({ type: 'source', source });
    // The patterns the card shows are the ones of the new source.
    this.patternCache.clear();
    this.wake();
  }

  /** Read a user pattern slot back from the engine. */
  getUserPattern(index: number): Promise<UserPattern> {
    const inflight = this.userPatternPending.get(index);
    if (inflight !== undefined) {
      return inflight;
    }

    const request = new Promise<UserPattern>((resolve, reject) => {
      this.userPatternRequests.set(index, { resolve, reject });
      this.post({ type: 'userPatternRequest', index });
      this.wake();
    })
      .then((pattern) => {
        this.userPatternPending.delete(index);
        return pattern;
      })
      .catch((error: unknown) => {
        this.userPatternPending.delete(index);
        throw error;
      });

    this.userPatternPending.set(index, request);
    return request;
  }

  /** Write a user pattern into a slot of the engine. */
  setUserPattern(index: number, pattern: UserPattern): void {
    this.post({ type: 'userPattern', index, pattern });
    // A pattern that changed is not in the cache any more.
    this.patternCache.clear();
    this.wake();
  }

  async dispose(): Promise<void> {
    this.gateNoise?.stop();
    this.gateNoise?.disconnect();
    this.gateNoise = null;
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    if (context !== null) {
      await context.close();
    }
  }

  private async ensure(): Promise<void> {
    if (this.fatal !== null) {
      throw this.fatal;
    }

    if (this.node !== null) {
      return;
    }

    if (this.starting !== null) {
      return this.starting;
    }

    this.starting = this.createNode();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async createNode(): Promise<void> {
    const unsupported = workletUnavailableReason();
    if (unsupported !== null) {
      this.fatal = new Error(unsupported);
      throw this.fatal;
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    const worklet: AudioWorklet | undefined = context.audioWorklet;
    if (worklet === undefined) {
      await context.close();
      this.fatal = new Error('this browser does not expose the Web Audio worklet');
      throw this.fatal;
    }

    try {
      const [bytes] = await Promise.all([
        fetch(wasmUrl).then(async (response) => {
          if (!response.ok) {
            throw new Error(`wasm request failed (${response.status})`);
          }
          return response.arrayBuffer();
        }),
        worklet.addModule(workletUrl),
      ]);

      // The binary is compiled here, in the main thread. A worklet may not
      // compile a module while its global scope is still initialising, and
      // a compiled module can be handed over to it as it is.
      const wasmModule = await WebAssembly.compile(bytes);

      const node = this.createWorkletNode(context, wasmModule, bytes);

      node.port.onmessage = (event: MessageEvent<EngineEvent>) => {
        this.handleEvent(event.data);
      };
      node.addEventListener('processorerror', () => {
        this.emitError('the audio processor stopped unexpectedly');
      });

      node.connect(context.destination);
      this.gateNoise = this.createGateNoise(context);
      this.gateNoise.connect(context.destination);
      this.gateNoise.start();
      this.context = context;
      this.node = node;
      this.applySettings();
      for (const command of this.pending) {
        node.port.postMessage(command);
      }
      this.pending.length = 0;
      // The context starts on its own once the page has been activated. The
      // resume is not awaited: the autoplay policy may hold it back until a
      // gesture happens, and the engine has to stay usable in the meantime.
      void this.resume();
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  /**
   * Build the constant noise floor that keeps a speaker's noise gate open.
   *
   * The samples are generated once, by the browser, into a looping buffer:
   * the hardware plays them from then on, so the worklet and the main thread
   * spend no work per sample on the workaround.
   */
  private createGateNoise(context: AudioContext): AudioBufferSourceNode {
    const frames = Math.ceil(context.sampleRate * GATE_NOISE_SECONDS);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * GATE_NOISE_AMPLITUDE;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  /**
   * Build the worklet node.
   *
   * The compiled module is the fast way in: the worklet only has to
   * instantiate it, and the engine is ready right away. Browsers that
   * cannot hand a compiled module over to the worklet get the bytes
   * instead, and the worklet compiles them itself.
   */
  private createWorkletNode(
    context: AudioContext,
    wasmModule: WebAssembly.Module,
    bytes: ArrayBuffer,
  ): AudioWorkletNode {
    const options: AudioWorkletNodeOptions = {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    };

    try {
      return new AudioWorkletNode(context, 'poppy-processor', {
        ...options,
        processorOptions: { wasmModule },
      });
    } catch {
      return new AudioWorkletNode(context, 'poppy-processor', {
        ...options,
        processorOptions: { wasmBinary: bytes.slice(0) },
      });
    }
  }

  private async resume(): Promise<void> {
    const context = this.context;
    if (context === null || context.state === 'running') {
      return;
    }
    try {
      await context.resume();
    } catch {
      // A closed context cannot be resumed; the transport stays silent.
    }
  }

  private applySettings(): void {
    this.post({ type: 'tempo', bpm: this.settings.tempo });
    this.post({ type: 'volume', value: this.settings.volume });
    this.post({ type: 'balance', value: this.settings.balance });
    this.settings.instrGain.forEach((value, instrument) => {
      this.post({ type: 'instrGain', instrument, value });
    });
    this.post({ type: 'accentGain', value: this.settings.accentGain });
    this.post({ type: 'spread', value: this.settings.spread });
    this.settings.instrPan.forEach((value, instrument) => {
      this.post({ type: 'instrPan', instrument, value });
    });
    this.post({ type: 'snare1Decay', value: this.settings.snare1Decay });
    this.post({ type: 'snare1Cutoff', value: this.settings.snare1Cutoff });
    this.post({ type: 'hihatCutoff', value: this.settings.hihatCutoff });
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
      const reason = error instanceof Error ? error : new Error(String(error));
      this.emitError(reason.message);
      this.rejectAllPatternRequests(reason);
    });
    // A control that is moved is a user gesture: it may bring a context
    // that the browser suspended back to life.
    void this.resume();
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
        // The answer carries the selection it belongs to, so a request that
        // is overtaken by another one still finds its own answer.
        const key = `${event.bank}:${event.buttons}`;
        const handlers = this.patternRequests.get(key);
        if (handlers !== undefined) {
          this.patternRequests.delete(key);
          handlers.resolve(event.view);
        }
        break;
      }
      case 'userPattern': {
        const handlers = this.userPatternRequests.get(event.index);
        if (handlers !== undefined) {
          this.userPatternRequests.delete(event.index);
          handlers.resolve(event.pattern);
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
    for (const handlers of this.userPatternRequests.values()) {
      handlers.reject(reason);
    }
    this.userPatternRequests.clear();
  }
}
