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
  type VoiceParam,
} from './protocol';

const Q16 = 65536;
const FALLBACK_SAMPLE_RATE = 48000;

interface Settings {
  tempo: number;
  volume: number;
  balance: number;
  instrGain: number[];
  /** The gain an accented column is played at, Q16. */
  accentGain: number;
  /** The spread of the instruments over the stereo field, -1 to 1. */
  spread: number;
  /** The parameters of the voices that have been moved, by instrument. */
  voiceParams: Map<number, Map<VoiceParam, number>>;
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
    // The instruments stand in the centre of the stereo field, the way
    // the engine comes up.
    spread: 0,
    voiceParams: new Map<number, Map<VoiceParam, number>>(),
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
  private patternCache = new Map<number, PatternView>();
  private patternPending = new Map<number, Promise<PatternView>>();
  private userPatternRequests = new Map<
    number,
    { resolve: (pattern: UserPattern) => void; reject: (reason: Error) => void }
  >();
  private userPatternPending = new Map<number, Promise<UserPattern>>();
  private defaultUserPatternRequests = new Map<
    number,
    { resolve: (pattern: UserPattern) => void; reject: (reason: Error) => void }
  >();
  private defaultUserPatternPending = new Map<number, Promise<UserPattern>>();
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

  setInstrumentGain(instrument: number, value: number): void {
    if (instrument < 0 || instrument >= this.settings.instrGain.length) {
      return;
    }
    this.settings.instrGain[instrument] = value;
    this.post({ type: 'instrGain', instrument, value });
    this.wake();
  }

  /**
   * Move one parameter of one voice: the level, the attack, the decay, the
   * centre of the band-pass, the corner of the high-pass or the resonance
   * of the band-pass. The value is in the unit the engine uses for that
   * parameter.
   */
  setVoiceParam(instrument: number, param: VoiceParam, value: number): void {
    let params = this.settings.voiceParams.get(instrument);
    if (params === undefined) {
      params = new Map<VoiceParam, number>();
      this.settings.voiceParams.set(instrument, params);
    }
    params.set(param, value);
    this.post({ type: 'voiceParam', instrument, param, value });
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
   * centre of the field, at one every instrument stands as far to its own
   * side as it goes, and below zero the whole field is mirrored. The
   * instruments that stay in the centre are not touched.
   */
  setStereoSpread(value: number): void {
    const spread = Math.min(1, Math.max(-1, value));
    this.settings.spread = spread;
    this.post({ type: 'spread', value: spread });
    this.wake();
  }

  getPattern(rhythm: number): Promise<PatternView> {
    const cached = this.patternCache.get(rhythm);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const inflight = this.patternPending.get(rhythm);
    if (inflight !== undefined) {
      return inflight;
    }

    const request = new Promise<PatternView>((resolve, reject) => {
      this.patternRequests.set(rhythm, { resolve, reject });
      this.post({ type: 'pattern', rhythm });
      this.wake();
    })
      .then((view) => {
        this.patternCache.set(rhythm, view);
        this.patternPending.delete(rhythm);
        return view;
      })
      .catch((error: unknown) => {
        this.patternPending.delete(rhythm);
        throw error;
      });

    this.patternPending.set(rhythm, request);
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

  /**
   * Read the rhythm a user slot comes up with.
   *
   * It is the rhythm of the machine and not the pattern in the slot: the
   * pattern that was written in the slot does not change it, so the panel
   * can always put a slot back the way it came.
   */
  getDefaultUserPattern(index: number): Promise<UserPattern> {
    const inflight = this.defaultUserPatternPending.get(index);
    if (inflight !== undefined) {
      return inflight;
    }

    const request = new Promise<UserPattern>((resolve, reject) => {
      this.defaultUserPatternRequests.set(index, { resolve, reject });
      this.post({ type: 'defaultUserPatternRequest', index });
      this.wake();
    })
      .then((pattern) => {
        this.defaultUserPatternPending.delete(index);
        return pattern;
      })
      .catch((error: unknown) => {
        this.defaultUserPatternPending.delete(index);
        throw error;
      });

    this.defaultUserPatternPending.set(index, request);
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
    this.settings.voiceParams.forEach((params, instrument) => {
      params.forEach((value, param) => {
        this.post({ type: 'voiceParam', instrument, param, value });
      });
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
        const handlers = this.patternRequests.get(event.view.rhythm);
        if (handlers !== undefined) {
          this.patternRequests.delete(event.view.rhythm);
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
      case 'defaultUserPattern': {
        const handlers = this.defaultUserPatternRequests.get(event.index);
        if (handlers !== undefined) {
          this.defaultUserPatternRequests.delete(event.index);
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
    for (const handlers of this.defaultUserPatternRequests.values()) {
      handlers.reject(reason);
    }
    this.defaultUserPatternRequests.clear();
  }
}
