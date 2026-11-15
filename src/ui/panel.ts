import type { PoppyEngine } from '../audio/engine';
import {
  BAND_INSTRUMENTS,
  BAND_INSTRUMENT_COUNT,
  INITIAL_PANEL_STATE,
  INSTRUMENT_NAMES,
  INSTR_BASS,
  INSTR_CLAVES,
  INSTR_CONGA,
  INSTR_COWBELL,
  INSTR_CYMBAL_1,
  INSTR_CYMBAL_2,
  INSTR_HIHAT,
  INSTR_LARGE_BONGO,
  INSTR_QUIJADA,
  INSTR_RIMSHOT,
  INSTR_SMALL_BONGO,
  INSTR_SNARE_1,
  INSTR_SNARE_2,
  INSTR_TAMBORINE,
  PATTERN_ACCENT_BIT,
  PATTERN_COLUMNS,
  PATTERN_SOURCE_PRESET,
  PATTERN_SOURCE_USER,
  RHYTHM_BUTTON_COUNT,
  RHYTHM_NAMES,
  TIMESIG,
  type Bank,
  type PanelState,
  type PatternSource,
  type TimeSignature,
  type UserPattern,
} from '../audio/protocol';
import { seedPan } from '../audio/spread';
import { MidiClockSync } from '../audio/midi-clock';
import { FitScaler } from './fit';
import {
  ControlWriter,
  loadControlPositions,
  MEMORIES_VERSION,
  type ControlPositions,
  type StoredBandMemory,
} from './control-store';
import { PatternGrid, rhythmsFor } from './pattern-grid';
import {
  buildBankFile,
  chooseBankFile,
  downloadBankFile,
  patternFromFile,
  patternToFile,
  type BankFile,
} from './bank-file';
import { DEFAULT_RHYTHMS, defaultRhythm } from '../audio/default-rhythms';
import { loadUserPatterns, saveUserPatterns } from './user-store';
import { UserNames, defaultUserName } from './user-names';
import { meterOfTimesig } from './meter';
import { BandCode } from './band-code';
import { printedWord } from './wordmark';

const Q16 = 65536;

/**
 * The decay the voices the engine takes a decay for come up with, in
 * milliseconds.
 *
 * The engine takes the decay of a voice as a multiplier of the decay it
 * comes up with, so the knob of the panel, which is in milliseconds,
 * turns one into the other. Every voice takes a decay but the Guiro: its
 * length is the gate the rhythm holds open, so it has none to scale.
 */
const FACTORY_DECAY_MS: Readonly<Record<number, number>> = {
  [INSTR_BASS]: 200,
  [INSTR_SNARE_1]: 400,
  [INSTR_SNARE_2]: 80,
  [INSTR_SMALL_BONGO]: 50,
  [INSTR_LARGE_BONGO]: 50,
  [INSTR_CONGA]: 250,
  [INSTR_COWBELL]: 50,
  [INSTR_CLAVES]: 4,
  [INSTR_HIHAT]: 20,
  [INSTR_RIMSHOT]: 1,
  [INSTR_CYMBAL_1]: 200,
  [INSTR_CYMBAL_2]: 200,
  [INSTR_TAMBORINE]: 80,
  [INSTR_QUIJADA]: 300,
};

/**
 * The center of the band-pass the voices the engine takes a cut-off for
 * come up with, in hertz. The engine clamps a cut-off to the range of
 * the voice, and the band-pass of the hi-hat cannot go below its factory
 * high-pass.
 */
const FACTORY_CUTOFF_HZ: Readonly<Record<number, number>> = {
  [INSTR_SNARE_1]: 5500,
  [INSTR_SNARE_2]: 5500,
  [INSTR_HIHAT]: 10000,
};

/**
 * The corner of the noise high-pass the voices the engine takes one for
 * come up with, in hertz.
 *
 * The two cymbals are the voices the extended build of the engine
 * exposes the high-pass for: their band-pass is fixed, so the high-pass
 * is the tone control of their voice.
 */
const FACTORY_HIGHPASS_HZ: Readonly<Record<number, number>> = {
  [INSTR_CYMBAL_1]: 5500,
  [INSTR_CYMBAL_2]: 5500,
};

/**
 * Whether the engine takes the cut-off of a voice.
 *
 * The snare 1, the snare 2 and the hi-hat are the voices the extended
 * build of the engine exposes it for; every other voice has no knob for
 * it and the knob stands dimmed. The decay is a wider thing: the engine
 * takes it of every voice the selector can reach for.
 */
function hasCutoff(instrument: number): boolean {
  return (
    instrument === INSTR_SNARE_1 ||
    instrument === INSTR_SNARE_2 ||
    instrument === INSTR_HIHAT
  );
}

/**
 * Whether the engine takes the high-pass of a voice.
 *
 * The two cymbals are the voices the extended build of the engine
 * exposes it for; every other voice has no knob for it and the knob
 * stands dimmed.
 */
function hasHighpass(instrument: number): boolean {
  return instrument === INSTR_CYMBAL_1 || instrument === INSTR_CYMBAL_2;
}

/**
 * Whether the engine takes the filter of a voice.
 *
 * The knob of the band is the cut-off of the snares and of the hi-hat
 * and the high-pass of the two cymbals: every other voice has no
 * filter of its own to move, and the knob stands dimmed for it.
 */
function hasFilter(instrument: number): boolean {
  return hasCutoff(instrument) || hasHighpass(instrument);
}

/**
 * The range the cut-off knob takes for an instrument.
 *
 * The hi-hat's band-pass cannot go below its factory high-pass, so its
 * range starts higher than the range of the snares. The bounds are used
 * both by the knob and when a stored memory position is brought back into
 * the shape of today, so the knob and the engine cannot disagree.
 */
function cutoffBounds(instrument: number): { min: number; max: number } {
  return instrument === INSTR_HIHAT
    ? { min: 2000, max: 15000 }
    : { min: 1000, max: 15000 };
}

/**
 * The range the high-pass of a voice takes.
 *
 * The engine clamps the corner of the high-pass to the range of the
 * voice: it never goes below 2 kHz, so the metallic voices stay out of
 * the low band, and it never goes above 5.5 kHz, the factory value,
 * which sits a hundred Hz below the fixed band-pass of the cymbals.
 */
function highpassBounds(instrument: number): { min: number; max: number } {
  return { min: 2000, max: 5500 };
}

/**
 * The range the filter knob takes for an instrument.
 *
 * The knob is the cut-off of the snares and of the hi-hat, and the
 * high-pass of the two cymbals, whose band-pass is fixed: it is the
 * filter the voice has, and it takes the range of that filter.
 */
function filterBounds(instrument: number): { min: number; max: number } {
  return hasHighpass(instrument)
    ? highpassBounds(instrument)
    : cutoffBounds(instrument);
}

/**
 * The value the filter knob stands at when the machine comes up.
 *
 * It is the cut-off of the snares and of the hi-hat, and the high-pass
 * of the two cymbals.
 */
function factoryFilterHz(instrument: number): number {
  return (
    FACTORY_CUTOFF_HZ[instrument] ?? FACTORY_HIGHPASS_HZ[instrument] ?? 5500
  );
}

/**
 * How many memory positions the band of knobs has.
 *
 * A memory position keeps the settings of the knobs: the square of four
 * buttons at the end of the band picks the position that is in use, and
 * the button next to it puts the knobs of that position back where they
 * come up in. The other positions keep the settings they were given.
 */
const BAND_MEMORY_COUNT = 4;

/** One of the parameters of an instrument the band of knobs holds. */
type BandParam = 'vol' | 'pan' | 'tone' | 'filter' | 'decay' | 'send';

/**
 * The settings of one instrument inside a memory position.
 */
interface InstrumentSettings {
  /** The level, from silence to twice the level the voice comes up with. */
  vol: number;
  /** The place in the stereo field: -1 is hard left, 1 is hard right. */
  pan: number;
  /** The tone, as a multiplier of what the engine pitches in the voice. */
  tone: number;
  /**
   * The filter of the voice, in hertz: the center of the band-pass of
   * the snares and of the hi-hat, the corner of the high-pass of the
   * two cymbals.
   */
  filter: number;
  /** The decay, as a multiplier of the factory decay. */
  decay: number;
  /** The reverb send, from nothing to the full level. */
  send: number;
}

/**
 * One memory position of the band of knobs.
 *
 * It carries the accent gain and the settings of every instrument the
 * selector can pick, in the order of BAND_INSTRUMENTS.
 */
interface BandMemoryPosition {
  /** The gain an accented column is played at. */
  accent: number;
  /** The settings of the twelve instruments of the selector. */
  instruments: InstrumentSettings[];
}

/** The settings of an instrument the machine comes up with. */
function defaultInstrumentSettings(instrument: number): InstrumentSettings {
  return {
    vol: 1,
    pan: 0,
    tone: 1,
    filter: factoryFilterHz(instrument),
    decay: 1,
    send: 0,
  };
}

/** The memory position the settings of the machine come up with. */
function defaultBandMemory(): BandMemoryPosition {
  return {
    accent: 1.2,
    instruments: BAND_INSTRUMENTS.map(defaultInstrumentSettings),
  };
}

/**
 * The memory position the first of the four positions is seeded with.
 *
 * The accent comes up at 1.40, and every instrument stands at half of
 * the way to its side in the printed stereo field of the machine, which
 * is where the PAN knob comes up for it. A knob that is turned writes
 * over the seed, and the reset button puts the position back to the
 * default values and the seed is lost.
 */
function seededBandMemory(): BandMemoryPosition {
  return {
    accent: 1.4,
    instruments: BAND_INSTRUMENTS.map((instrument) => ({
      ...defaultInstrumentSettings(instrument),
      pan: seedPan(instrument),
    })),
  };
}

/**
 * One of the six parameter knobs of the band.
 *
 * Every one of them acts on the instrument the selector of the band
 * stands at. A knob the engine takes nothing from for an instrument
 * stands dimmed and takes no input.
 */
interface BandParamKnob {
  param: BandParam;
  /** The printed caption. */
  label: string;
  /** The name the screen reader gets. */
  ariaLabel: string;
  /** The smallest and largest value the knob takes for an instrument. */
  bounds: (instrument: number) => { min: number; max: number };
  /** The value the engine comes up with. */
  defaultValue: (instrument: number) => number;
  /** The shape the dial travels with; a straight line by default. */
  taper?: 'linear' | 'geometric';
  /** Whether the engine takes the parameter from this instrument. */
  supported: (instrument: number) => boolean;
  /** What the value is called; it names the instrument it belongs to. */
  valueText: (value: number, instrument: number) => string;
  /** What the knob does when it is moved. */
  apply: (value: number, instrument: number) => void;
}

/** The six parameter knobs of the band, in the order of the row. */
function bandParamKnobs(engine: PoppyEngine): BandParamKnob[] {
  return [
    {
      param: 'vol',
      label: 'VOL',
      ariaLabel: 'Level of the selected instrument',
      // The engine takes the level of a voice from silence to twice the
      // level the original unit plays it at, so the knob stands between
      // 0 and 2, with the original level in the middle.
      bounds: () => ({ min: 0, max: 2 }),
      defaultValue: () => 1,
      supported: () => true,
      valueText: (value) => `${value.toFixed(2)}x`,
      apply: (value, instrument) => {
        engine.setInstrumentGain(instrument, Math.round(value * Q16));
      },
    },
    {
      param: 'pan',
      label: 'PAN',
      ariaLabel: 'Place of the selected instrument in the stereo field',
      // The knob stands between hard left and hard right, with the
      // center of the field in the middle of it.
      bounds: () => ({ min: -1, max: 1 }),
      defaultValue: () => 0,
      supported: () => true,
      valueText: (value) => {
        const percent = Math.round(Math.abs(value) * 100);
        if (percent === 0) {
          return 'C';
        }
        return `${value < 0 ? 'L' : 'R'} ${percent}%`;
      },
      apply: (value, instrument) => {
        engine.setInstrumentPan(
          instrument,
          Math.round((0.5 + value / 2) * Q16),
        );
      },
    },
    {
      param: 'tone',
      label: 'TONE',
      ariaLabel: 'Tone of the selected instrument',
      // The knob is a multiplier of what the engine pitches in the
      // voice: half of it and twice it, one octave either side, with
      // the factory tone in the middle of it. The travel is even in
      // octaves, so the middle of the dial is the factory tone. The
      // engine takes it for every instrument, and it does not reach
      // the pitch alone: a voice whose tone carries a band-pass moves
      // the center of it as well.
      bounds: () => ({ min: 0.5, max: 2 }),
      defaultValue: () => 1,
      taper: 'geometric',
      supported: () => true,
      valueText: (value) => `${value.toFixed(2)}x`,
      apply: (value, instrument) => {
        engine.setInstrumentTune(instrument, Math.round(value * Q16));
      },
    },
    {
      param: 'filter',
      label: 'CUTOFF',
      ariaLabel: 'Filter of the selected instrument',
      // The knob is the filter the voice has. The snare 1, the snare 2
      // and the hi-hat are voices with a band-pass: the knob is the
      // center of it, and the hi-hat's band-pass cannot go below its
      // factory high-pass at 1 kHz. The two cymbals have no band-pass
      // of their own: the knob is the corner of their high-pass, the
      // low end of their noise.
      bounds: filterBounds,
      defaultValue: factoryFilterHz,
      supported: hasFilter,
      valueText: (value, instrument) =>
        hasFilter(instrument) ? `${(value / 1000).toFixed(1)} kHz` : '—',
      apply: (value, instrument) => {
        if (hasHighpass(instrument)) {
          engine.setInstrumentHighpass(instrument, Math.round(value));
          return;
        }
        engine.setInstrumentCutoff(instrument, Math.round(value));
      },
    },
    {
      param: 'decay',
      label: 'DECAY',
      ariaLabel: 'Decay of the selected instrument',
      // The knob is a multiplier of the decay the voice comes up with:
      // a fifth of it and five times it, with the factory decay in the
      // middle of it. The travel is even in ratios, so the middle of the
      // dial is the factory decay. The engine takes the decay of every
      // instrument the selector can pick; the Guiro, whose length is the
      // gate the rhythm holds open, has none to scale.
      bounds: () => ({ min: 0.2, max: 5 }),
      defaultValue: () => 1,
      taper: 'geometric',
      supported: () => true,
      valueText: (value, instrument) =>
        `${Math.round((FACTORY_DECAY_MS[instrument] ?? 0) * value)} ms`,
      apply: (value, instrument) => {
        engine.setInstrumentDecay(instrument, Math.round(value * Q16));
      },
    },
    {
      param: 'send',
      label: 'REVERB',
      ariaLabel: 'Reverb send of the selected instrument',
      bounds: () => ({ min: 0, max: 1 }),
      defaultValue: () => 0,
      supported: () => true,
      valueText: (value) => `${Math.round(value * 100)}%`,
      apply: (value, instrument) => {
        engine.setInstrumentFxSend(instrument, Math.round(value * Q16));
      },
    },
  ];
}

/**
 * How long a control has to be held down before the press counts as a
 * long press. A short press on a rhythm key picks a single rhythm, a long
 * press adds to the selection, and the reset button takes a long press
 * before it puts the settings back.
 */
const LONG_PRESS_MS = 500;

/**
 * How long the reset button has to be held down before it puts the knobs
 * of the selected memory position back to their defaults. It is longer
 * than the long press of the keys: the reset throws the settings away, so
 * it takes a deliberate hold.
 */
const RESET_HOLD_MS = 1500;

/**
 * How many keys may be held down at the same time. Two is what a chord
 * is: two fingers on two keys latch them together, the way two keys
 * pressed at the same time do on the machine.
 */
const MAX_SIMULTANEOUS_KEYS = 2;

/**
 * How long the names on the key bed are gone before the new ones are
 * written. The names fade out, the new ones take their place while they
 * cannot be seen, and they fade in again.
 */
const LEGEND_FADE_MS = 120;

/** A key that is being held down. */
interface KeyPress {
  index: number;
  /** The long press has already been carried out. */
  long: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** The press is one half of a chord. */
  chord: boolean;
  /**
   * The place the key was when the finger went down.
   */
  footprint: Footprint | null;
}

/**
 * The place on the panel a press belongs to.
 *
 * A key that is pressed travels a little, and the box the pointer can
 * hit travels with it: a finger that rests on the lower edge of a key
 * ends up outside the key while the key sinks into the bed. The
 * footprint of a press is the place the key was when the finger went
 * down, so a press that ends on the key is a press, wherever the key
 * happens to be drawn at that moment.
 */
interface Footprint {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far a key travels while it is pressed, in the pixels of the
 * screen.
 *
 * The travel is read from the panel itself, so the number that draws
 * the key moving is the number that tells the press where the key is.
 * The machine is scaled down as a whole when the room is too small, so
 * the travel of a key is scaled with it.
 */
function travelOf(button: HTMLElement): number {
  const travel = parseFloat(
    getComputedStyle(button).getPropertyValue('--travel'),
  );
  if (!Number.isFinite(travel) || travel <= 0) {
    return 0;
  }
  const layout = button.offsetWidth;
  if (layout === 0) {
    return travel;
  }
  return travel * (button.getBoundingClientRect().width / layout);
}

/** The place a key can be pressed, with the travel of the key around it. */
function footprintOf(button: HTMLElement): Footprint {
  const rect = button.getBoundingClientRect();
  const travel = travelOf(button);
  return {
    top: rect.top - travel,
    bottom: rect.bottom + travel,
    left: rect.left,
    right: rect.right,
  };
}

/** Whether a point lies on a footprint. */
function onFootprint(footprint: Footprint, x: number, y: number): boolean {
  return (
    x >= footprint.left &&
    x <= footprint.right &&
    y >= footprint.top &&
    y <= footprint.bottom
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rhythmIndexForKey(key: string): number | null {
  if (key === '0') {
    return 9;
  }
  if (key >= '1' && key <= '9') {
    return Number(key) - 1;
  }
  return null;
}

/**
 * The rhythm key a number key stands for. The printed key is looked at
 * first, so the key that reads "1" presses the first rhythm on every
 * layout; the physical key is the fallback for the layouts where the
 * digits need a modifier.
 */
function rhythmShortcutFor(
  event: KeyboardEvent,
): { id: string; index: number } | null {
  const id = event.code !== '' ? event.code : `key:${event.key}`;

  const index = rhythmIndexForKey(event.key);
  if (index !== null) {
    return { id, index };
  }

  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  if (match === null) {
    return null;
  }
  const digit = Number(match[1]);
  return { id, index: digit === 0 ? 9 : digit - 1 };
}

/**
 * The pattern of a slot that was cleared: a full 64-column grid with every
 * column enabled and no instrument in it.
 */
function emptyUserPattern(): UserPattern {
  return {
    notes: new Array<number>(PATTERN_COLUMNS).fill(0),
    timesig: TIMESIG['4/4'],
  };
}

interface FaderOptions {
  label: string;
  ariaLabel?: string;
  color: 'blue' | 'yellow';
  value: number;
  onInput: (value: number) => void;
  // Where the printed 0/5/10 numbers sit: at the right end of the scale
  // (the blue trio's inter-fader gaps), at the left of the volume fader,
  // which its balance neighbour reads, or not at all (tambourine and
  // balance end their scale band at the slot).
  scale?: 'right' | 'left' | 'end' | 'pair-end';
}

class Fader {
  readonly element: HTMLDivElement;
  private readonly travel: HTMLDivElement;
  private readonly cap: HTMLDivElement;
  private value: number;
  private readonly onInput: (value: number) => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(options: FaderOptions) {
    this.value = clamp(options.value, 0, 100);
    this.onInput = options.onInput;

    const scaleSide = options.scale ?? 'right';
    this.element = element('div', `fader fader--${scaleSide}`);
    this.element.setAttribute('role', 'slider');
    this.element.setAttribute('aria-orientation', 'vertical');
    this.element.setAttribute(
      'aria-label',
      options.ariaLabel ?? `${options.label} volume`,
    );
    this.element.setAttribute('aria-valuemin', '0');
    this.element.setAttribute('aria-valuemax', '100');

    if (scaleSide === 'right' || scaleSide === 'left') {
      const digits = element('div', 'fader-digits');
      digits.setAttribute('aria-hidden', 'true');
      digits.append(
        element('span', 'fader-tick tick-10', '10'),
        element('span', 'fader-tick tick-5', '5'),
        element('span', 'fader-tick tick-0', '0'),
      );
      this.element.append(digits);
    }

    this.travel = element('div', 'fader-travel');
    const slot = element('div', 'fader-slot');
    this.cap = element('div', `fader-cap ${options.color}`);
    this.travel.append(slot, this.cap);

    const name = element('span', 'fader-name', options.label);
    this.element.append(this.travel, name);

    this.element.addEventListener('pointerdown', (event) => {
      this.element.setPointerCapture(event.pointerId);
      this.pointerTo(event.clientY);
    });
    this.element.addEventListener('pointermove', (event) => {
      if (this.element.hasPointerCapture(event.pointerId)) {
        this.pointerTo(event.clientY);
      }
    });
    this.element.addEventListener('pointerup', (event) => {
      this.element.releasePointerCapture(event.pointerId);
    });
    this.element.addEventListener('pointercancel', (event) => {
      this.element.releasePointerCapture(event.pointerId);
    });

    this.resizeObserver = new ResizeObserver(() => this.position());
    this.render();
  }

  set(value: number, notify: boolean): void {
    this.value = clamp(value, 0, 100);
    this.render();
    if (notify) {
      this.onInput(this.value);
    }
  }

  /** The position the fader stands at. */
  get current(): number {
    return this.value;
  }

  observe(): void {
    this.resizeObserver.observe(this.travel);
    this.position();
  }

  private pointerTo(clientY: number): void {
    const rect = this.travel.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    this.set(ratio * 100, true);
  }

  private render(): void {
    this.element.setAttribute('aria-valuenow', String(Math.round(this.value)));
    this.element.setAttribute(
      'aria-valuetext',
      `${Math.round(this.value)} percent`,
    );
    this.position();
  }

  private position(): void {
    const travelHeight = this.travel.clientHeight;
    const capHeight = this.cap.offsetHeight || 20;
    const range = Math.max(0, travelHeight - capHeight);
    this.cap.style.top = `${(1 - this.value / 100) * range}px`;
  }
}

interface KnobOptions {
  min: number;
  max: number;
  value: number;
  onInput: (value: number) => void;
}

class Knob {
  readonly element: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly dial: HTMLDivElement;
  private readonly readout: HTMLOutputElement;
  private value: number;
  private readonly min: number;
  private readonly max: number;
  private readonly onInput: (value: number) => void;
  /** Whether the knob takes an input at all. */
  private enabled = true;
  /**
   * The print of the tempo the knob does not set.
   *
   * While an external clock drives the tempo, the readout tells the tempo
   * the clock hands over and no longer points at the knob's own value.
   */
  private external: string | null = null;

  constructor(options: KnobOptions) {
    this.min = options.min;
    this.max = options.max;
    this.value = options.value;
    this.onInput = options.onInput;

    this.element = element('div', 'tempo');
    const ticks = element('div', 'tempo-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 11; index += 1) {
      const tick = element('span', 'tempo-tick');
      tick.style.setProperty('--tick', `${-135 + index * 27}deg`);
      ticks.append(tick);
    }

    this.base = element('div', 'knob-base');
    this.dial = element('div', 'knob');
    this.dial.setAttribute('role', 'slider');
    this.dial.setAttribute('aria-label', 'Tempo');
    this.dial.setAttribute('aria-valuemin', String(this.min));
    this.dial.setAttribute('aria-valuemax', String(this.max));
    // The knob body stays put; only the white index line sweeps, so the
    // knurling and the drop shadow never make the dial look off-center.
    const pointer = element('span', 'knob-pointer');
    pointer.setAttribute('aria-hidden', 'true');
    this.base.append(this.dial, pointer);

    this.readout = element('output', 'tempo-readout');
    const caption = element('div', 'tempo-caption');
    // SLOW/FAST flank the knob; the name sits on its own line below,
    // in the same print as the fader labels.
    const edges = element('div', 'tempo-edges');
    edges.append(
      element('span', 'tempo-edge', 'SLOW'),
      element('span', 'tempo-edge', 'FAST'),
    );
    caption.append(edges, element('span', 'tempo-name', 'TEMPO'));

    this.element.append(ticks, this.base, caption, this.readout);

    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartValue = 0;
    this.dial.addEventListener('pointerdown', (event) => {
      if (!this.enabled) {
        return;
      }
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragStartValue = this.value;
      this.dial.setPointerCapture(event.pointerId);
    });
    this.dial.addEventListener('pointermove', (event) => {
      if (!this.enabled || !this.dial.hasPointerCapture(event.pointerId)) {
        return;
      }
      // The knob turns with the finger, so the drag is measured in the
      // size the knob is seen at, not in the size it is laid out in.
      // Up and to the right raise the value, down and to the left lower
      // it, so a knob at the top or the bottom edge of a touch screen
      // keeps the length of the drag it needs across the short axis.
      const delta =
        (dragStartY - event.clientY + (event.clientX - dragStartX)) /
        this.scale() *
        0.85;
      this.set(dragStartValue + delta, true);
    });
    this.dial.addEventListener('pointerup', (event) => {
      this.dial.releasePointerCapture(event.pointerId);
    });
    this.dial.addEventListener('pointercancel', (event) => {
      this.dial.releasePointerCapture(event.pointerId);
    });
    this.dial.addEventListener(
      'wheel',
      (event) => {
        if (!this.enabled) {
          return;
        }
        event.preventDefault();
        this.set(this.value + (event.deltaY < 0 ? 2 : -2), true);
      },
      { passive: false },
    );

    this.render();
  }

  set(value: number, notify: boolean): void {
    this.value = clamp(Math.round(value), this.min, this.max);
    this.render();
    if (notify && this.enabled) {
      this.onInput(this.value);
    }
  }

  /** The value the knob stands at. */
  get current(): number {
    return this.value;
  }

  /**
   * Whether the knob takes an input.
   *
   * A knob whose value an external clock owns stands dimmed, and the
   * screen reader is told it is not available.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.applyEnabled();
  }

  /**
   * The print that stands in for the knob's own readout.
   *
   * A null puts the knob's own value back on the readout; a text is
   * printed as it is, the tempo of the external clock, for example.
   */
  setExternal(text: string | null): void {
    if (text === this.external) {
      return;
    }
    this.external = text;
    this.render();
  }

  private applyEnabled(): void {
    if (this.enabled) {
      this.dial.removeAttribute('aria-disabled');
      this.element.classList.remove('tempo--dead');
    } else {
      this.dial.setAttribute('aria-disabled', 'true');
      this.element.classList.add('tempo--dead');
    }
  }

  /**
   * How much the knob is scaled down. The machine is scaled as a whole
   * when the viewport is too small for it, and a drag over the scaled
   * knob has to cover as much ground as a drag over the knob itself.
   */
  private scale(): number {
    const width = this.dial.offsetWidth;
    if (width === 0) {
      return 1;
    }
    return this.dial.getBoundingClientRect().width / width;
  }

  private render(): void {
    const ratio = (this.value - this.min) / (this.max - this.min);
    this.base.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
    this.dial.setAttribute('aria-valuenow', String(this.value));
    this.dial.setAttribute(
      'aria-valuetext',
      this.external === null
        ? `${this.value} beats per minute`
        : `${this.value} beats per minute, not in use: the steps follow the external MIDI clock`,
    );
    this.readout.value = this.external ?? `${this.value} BPM`;
  }
}

interface MiniKnobOptions {
  /** The printed caption under the knob. */
  label: string;
  /** The smallest value the knob takes. */
  min: number;
  /** The largest value the knob takes. */
  max: number;
  /** The value the knob stands at. */
  value: number;
  /** The name the screen reader gets. */
  ariaLabel: string;
  /** What the current value is called. */
  valueText: (value: number) => string;
  /** Whether the knob reads out its value at all. */
  showReadout?: boolean;
  /**
   * How many detents the knob slots itself into.
   *
   * A knob with detents travels freely under the finger and slots itself
   * into the nearest of them when it is released; the wheel moves it from
   * one detent to the next.
   */
  steps?: number;
  /**
   * The shape the dial travels with.
   *
   * A knob with a geometric taper travels even in octaves: the dial turns
   * multiplicatively over the range, so the values double or halve over
   * equal parts of the travel and the middle of the travel stands at the
   * value between the two. It is what the tone knob wants: the tone
   * doubles and halves, and the factory tone stands in the middle. Both
   * ends of the range have to be above zero.
   */
  taper?: 'linear' | 'geometric';
  /** Whether the knob takes an input at all. */
  enabled?: boolean;
  onInput: (value: number) => void;
}

/**
 * How far the finger travels to turn a knob of the band over its whole
 * range. The knob is scaled down with the machine, so the travel is
 * measured in the size the knob is seen at.
 */
const MINI_KNOB_TRAVEL = 150;

/**
 * One of the small knobs of the write strip: a rotary control with a
 * printed caption. The knob turns with the finger, in steps, and the arrow
 * keys turn it as well.
 */
class MiniKnob {
  readonly element: HTMLDivElement;
  private readonly dial: HTMLDivElement;
  private readonly readout: HTMLSpanElement;
  private readonly caption: HTMLSpanElement;
  private value: number;
  private min: number;
  private max: number;
  /** How many detents the knob slots into; zero turns freely. */
  private readonly steps: number;
  /** The shape the dial travels with: a straight line by default. */
  private readonly taper: 'linear' | 'geometric';
  private enabled: boolean;
  /** The knob is being dragged: a stepped one slots in on the release. */
  private dragging = false;
  /**
   * The detent a stepped knob last told the panel about while it was
   * dragged, so the settings behind it follow the instrument under the
   * finger and not only the one the knob is let go at.
   */
  private stepNotified: number | null = null;
  private readonly onInput: (value: number) => void;
  private readonly valueText: (value: number) => string;
  private readonly showReadout: boolean;

  constructor(options: MiniKnobOptions) {
    this.min = options.min;
    this.max = options.max;
    this.value = clamp(options.value, this.min, this.max);
    this.steps = options.steps ?? 0;
    this.taper = options.taper ?? 'linear';
    this.enabled = options.enabled ?? true;
    this.onInput = options.onInput;
    this.valueText = options.valueText;
    this.showReadout = options.showReadout ?? true;

    this.element = element('div', 'mini-knob');
    this.dial = element('div', 'mini-dial');
    this.dial.setAttribute('role', 'slider');
    this.dial.setAttribute('aria-label', options.ariaLabel);
    this.dial.setAttribute('aria-valuemin', String(this.min));
    this.dial.setAttribute('aria-valuemax', String(this.max));
    this.applyEnabled();

    const pointer = element('span', 'mini-pointer');
    pointer.setAttribute('aria-hidden', 'true');
    this.dial.append(pointer);

    // The knob reads out the value it points at: the name of the
    // parameter and where it stands.
    this.readout = element('span', 'mini-readout');
    this.caption = element('span', 'mini-caption', options.label);

    this.element.append(this.dial);
    if (this.showReadout) {
      this.element.append(this.readout);
    }
    this.element.append(this.caption);

    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartTravel = 0;
    this.dial.addEventListener('pointerdown', (event) => {
      if (!this.enabled) {
        return;
      }
      this.dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragStartTravel = this.travelOf(this.value);
      this.stepNotified = this.steps > 0 ? this.stepOf(this.value) : null;
      this.dial.setPointerCapture(event.pointerId);
    });
    this.dial.addEventListener('pointermove', (event) => {
      if (!this.enabled || !this.dial.hasPointerCapture(event.pointerId)) {
        return;
      }
      // The knob turns with the finger, so the drag is measured in the
      // size the knob is seen at, not in the size it is laid out in. Up
      // and to the right raise the value, down and to the left lower it,
      // so a knob at the top or the bottom edge of a touch screen keeps
      // the length of the drag it needs across the short axis. A
      // stepped knob travels freely while it is held and slots itself
      // into a detent when it is released. The detent under the finger
      // is reported as it changes, so what the knob selects follows the
      // turn and not only the end of it.
      const travel =
        dragStartTravel +
        (dragStartY - event.clientY + (event.clientX - dragStartX)) /
          this.scale() /
          MINI_KNOB_TRAVEL;
      const value = this.valueOf(travel);
      this.set(value, this.steps === 0, this.steps === 0);
      if (this.steps > 0) {
        const step = this.stepOf(value);
        if (step !== this.stepNotified) {
          this.stepNotified = step;
          this.onInput(value);
        }
      }
    });
    this.dial.addEventListener('pointerup', (event) => {
      this.dial.releasePointerCapture(event.pointerId);
      this.release();
    });
    this.dial.addEventListener('pointercancel', (event) => {
      this.dial.releasePointerCapture(event.pointerId);
      this.release();
    });
    this.dial.addEventListener(
      'wheel',
      (event) => {
        if (!this.enabled) {
          return;
        }
        event.preventDefault();
        const step = this.step() * (event.shiftKey ? 10 : 1);
        this.set(
          this.valueOf(this.travelOf(this.value) + (event.deltaY < 0 ? step : -step)),
          true,
        );
      },
      { passive: false },
    );

    this.render();
  }

  /** The value the knob stands at. */
  get current(): number {
    return this.value;
  }

  set(value: number, notify: boolean, snap = true): void {
    let next = clamp(value, this.min, this.max);
    if (snap && this.steps > 0) {
      const span = 1 / (this.steps - 1);
      const travel = Math.round(this.travelOf(next) / span) * span;
      next = clamp(this.valueOf(travel), this.min, this.max);
    }
    const changed = next !== this.value;
    this.value = next;
    this.render();
    if (notify && changed && this.enabled) {
      this.onInput(this.value);
    }
  }

  /**
   * Give the knob another range.
   *
   * The value the knob stands at is brought back into the range, and the
   * screen reader is told the new ends of it. The band of knobs uses it
   * when the selector picks an instrument whose parameter reaches over
   * another range.
   */
  setBounds(min: number, max: number): void {
    this.min = min;
    this.max = max;
    this.dial.setAttribute('aria-valuemin', String(this.min));
    this.dial.setAttribute('aria-valuemax', String(this.max));
    this.set(this.value, false);
  }

  /**
   * Whether the knob takes an input.
   *
   * A knob the engine takes nothing from for the instrument the selector
   * stands at stands dimmed, and the screen reader is told it is not
   * available.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    this.applyEnabled();
  }

  private applyEnabled(): void {
    if (this.enabled) {
      this.dial.removeAttribute('aria-disabled');
      this.element.classList.remove('mini-knob--dead');
    } else {
      this.dial.setAttribute('aria-disabled', 'true');
      this.element.classList.add('mini-knob--dead');
    }
  }

  /** The knob was let go: a stepped one slots itself into a detent. */
  private release(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    if (this.steps > 0) {
      this.set(this.value, true);
      this.stepNotified = null;
    }
  }

  /** The detent a stepped knob is nearest to, as an index. */
  private stepOf(value: number): number {
    return Math.round(this.travelOf(value) * (this.steps - 1));
  }

  /**
   * How much one step of the wheel moves the knob, as a part of the
   * travel: a hundredth of the dial for a knob that turns freely, one
   * detent for a knob that slots into them.
   */
  private step(): number {
    if (this.steps > 0) {
      return 1 / (this.steps - 1);
    }
    return 1 / 100;
  }

  /**
   * The travel the dial stands at, between 0 and 1, for a value.
   *
   * A knob with a geometric taper travels even in octaves, so the value
   * is taken back along the shape of the range: the value the middle of
   * the travel stands at covers half of the dial.
   */
  private travelOf(value: number): number {
    if (this.taper === 'geometric' && this.min > 0 && this.max > 0) {
      return Math.log2(value / this.min) / Math.log2(this.max / this.min);
    }
    return (value - this.min) / (this.max - this.min);
  }

  /** The value the dial stands at, for a travel between 0 and 1. */
  private valueOf(travel: number): number {
    const span = clamp(travel, 0, 1);
    if (this.taper === 'geometric' && this.min > 0 && this.max > 0) {
      return this.min * Math.pow(this.max / this.min, span);
    }
    return this.min + (this.max - this.min) * span;
  }

  /**
   * How much the knob is scaled down. The machine is scaled as a whole
   * when the viewport is too small for it, and a drag over the scaled
   * knob has to cover as much ground as a drag over the knob itself.
   */
  private scale(): number {
    const width = this.dial.offsetWidth;
    if (width === 0) {
      return 1;
    }
    return this.dial.getBoundingClientRect().width / width;
  }

  private render(): void {
    const range = this.max - this.min;
    const ratio = range === 0 ? 0 : this.travelOf(this.value);
    this.dial.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
    if (this.steps > 0) {
      this.dial.setAttribute(
        'aria-valuenow',
        String(Math.round(ratio * (this.steps - 1))),
      );
    } else {
      this.dial.setAttribute('aria-valuenow', String(Math.round(this.value)));
    }
    this.dial.setAttribute('aria-valuetext', this.valueText(this.value));
    if (this.showReadout) {
      this.readout.textContent = this.valueText(this.value);
    }
  }
}

export class Panel {
  private readonly engine: PoppyEngine;
  private readonly root: HTMLDivElement;
  private readonly keyButtons: HTMLButtonElement[] = [];
  private readonly keySlots: HTMLElement[] = [];
  private readonly legendRows: HTMLElement[] = [];
  private readonly legendNames: HTMLElement[][] = [[], []];
  private rhythmSection!: HTMLElement;
  private readonly faders: Fader[] = [];
  /** The tempo knob of the panel. */
  private tempoKnob!: Knob;
  /** The switch that follows an external MIDI clock. */
  private midiSync!: HTMLButtonElement;
  /** Whether the tempo is being followed from an external MIDI clock. */
  private midiSyncOn = false;
  /**
   * Whether the replay is armed.
   *
   * While the clock is followed, a press on the start/stop switch does
   * not start the machine: it arms the replay, and the machine plays
   * when the clock starts and stops when the clock stops. The arming
   * survives a stop, so the clock can start the machine again - it is
   * taken back by the next press on the switch, or by the sync itself
   * going off.
   */
  private midiArmed = false;
  /**
   * The external MIDI clock.
   *
   * While it is followed, the timing clock pulses drive the steps of the
   * machine: every pulse is handed to the engine, which advances the
   * pattern at the pulses' own grid, so the machine cannot drift against
   * the clock its tempo is never measured for. The tempo setting knob
   * stands dimmed, and its readout prints the tempo the clock reports.
   * The messages of the transport follow with it - a start or a continue
   * plays, a stop takes the machine out - and they can only be read by
   * the inputs the sync listens to, so none of it happens while the sync
   * is off.
   */
  private readonly midi = new MidiClockSync({
    onPulse: () => {
      this.engine.midiPulse();
    },
    onTempo: (tempo) => {
      // A print, nothing more: the machine is driven by the pulses
      // themselves. Before the first interval - or while the clock says
      // nothing usable - the readout says where the tempo comes from.
      this.tempoKnob.setExternal(
        tempo.bpm > 0 ? `${Math.round(tempo.bpm)} BPM` : 'MIDI',
      );
    },
    onStart: () => {
      // The machine only plays on a start that it waits for: the press
      // on the switch armed the replay, and so it is what the clock
      // starts.
      if (!this.midiArmed) {
        return;
      }
      if (this.transportIntent) {
        // The clock started again while the machine plays - a restart of
        // the transport, say: the machine takes its first step again, so
        // its cycle re-anchors to the clock instead of staying wherever
        // the playing ran to.
        void this.engine.start();
        return;
      }
      this.startTransport();
    },
    onStop: () => {
      this.stopTransport();
    },
  });
  /**
   * The positions of the controls of the last visit.
   *
   * They are put back when the panel is built, so the machine comes up the
   * way it was left.
   */
  private readonly savedControls: ControlPositions;
  /** The writer of the positions of the controls. */
  private readonly controlWriter = new ControlWriter();
  /** The controls are being put back; there is nothing to write. */
  private restoring = false;
  private readonly lamps: [HTMLElement, HTMLElement];
  private bankSwitch!: HTMLButtonElement;
  private modeSwitch!: HTMLButtonElement;
  private startStop!: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;
  private readonly statusText: HTMLSpanElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerText: HTMLParagraphElement;
  private readonly card: PatternGrid;
  private readonly fitter: FitScaler;
  private cabinet!: HTMLElement;

  private state: PanelState = { ...INITIAL_PANEL_STATE };

  // The source the user has just picked. The panel shows it right away and
  // hands it over to the engine, which confirms it in the next snapshot.
  private sourceRequested: PatternSource | null = null;

  // The user patterns the panel knows about. They are the ones the strip
  // has read or written, and they are the ones that are kept in the
  // browser between two visits.
  private readonly userPatterns = new Map<number, UserPattern>();

  // The names of the user patterns. In the extended mode they take the
  // place of the factory names on the key bed.
  private readonly userNames = new UserNames();

  // The source the names on the key bed belong to. When it changes, the
  // names are replaced with a fade.
  private legendSource: PatternSource = PATTERN_SOURCE_PRESET;

  // The names on the key bed are being replaced: the old ones fade out
  // and the new ones come in.
  private legendFading = false;
  private legendTimer: ReturnType<typeof setTimeout> | null = null;

  // The band under the black cover: the row of knobs.
  private extendedSection!: HTMLElement;

  /** The knob that carries the gain an accented column is played at. */
  private accentKnob: MiniKnob | null = null;
  /** The knob that picks the instrument the six parameter knobs act on. */
  private selectorKnob: MiniKnob | null = null;
  /** The six parameter knobs of the band, in the order of the row. */
  private paramKnobs: BandParamKnob[] = [];
  /** The controls of the six parameter knobs, in the same order. */
  private readonly paramControls: MiniKnob[] = [];
  /**
   * The settings the machine comes up with.
   *
   * The factory rhythms are played with them, and the reset button of the
   * band puts the knobs of the selected memory position back to them.
   */
  private readonly bandDefaults: BandMemoryPosition = defaultBandMemory();
  /**
   * The settings the knobs of the band stand at.
   *
   * They are the settings of the memory position that is selected: the
   * factory rhythms are played with the settings the machine comes up
   * with, and the user patterns with the ones of that position.
   */
  private get bandValues(): BandMemoryPosition {
    return this.bandMemories[this.bandMemory] ?? this.bandDefaults;
  }

  /**
   * The memory positions of the knobs of the band.
   *
   * Every position keeps the accent gain and the settings of every
   * instrument the selector can pick. The position that is selected is
   * the one the knobs stand at: a knob that is turned writes into it, and
   * the position that is picked brings its own settings to the knobs.
   */
  private readonly bandMemories: BandMemoryPosition[] = [];

  /** The memory position of the knobs that is selected. */
  private bandMemory = 0;

  /**
   * The instrument the selector of the band stands at, as the index of
   * the twelve instruments in BAND_INSTRUMENTS.
   */
  private bandSelector = 0;

  /** The engine voice the selector of the band stands at. */
  private get bandInstrument(): number {
    return BAND_INSTRUMENTS[this.bandSelector] ?? INSTR_SNARE_1;
  }

  /**
   * The settings of the instrument the selector stands at, inside the
   * memory position that is selected.
   */
  private selectedInstrumentSettings(): InstrumentSettings {
    const memory = this.bandValues;
    const kept = memory.instruments[this.bandSelector];
    if (kept) {
      return kept;
    }
    const settings = defaultInstrumentSettings(this.bandInstrument);
    memory.instruments[this.bandSelector] = settings;
    return settings;
  }

  /** The buttons that pick the memory position of the knobs. */
  private readonly bandMemoryButtons: HTMLButtonElement[] = [];

  /**
   * The clipboard of the pattern editor.
   *
   * It is a temporary one: it holds the notes of the pattern that was
   * copied until they are pasted or the page is closed. It is not the
   * clipboard of the browser.
   */
  private clipboard: number[] | null = null;

  /** The user patterns are not in the browser until they are saved. */
  private patternsUnsaved = false;

  /**
   * The slots the user has written in.
   *
   * Only these are kept in the browser: a slot that was not written keeps
   * the rhythm it came up with, so a machine that comes up with new
   * rhythms gives them to a user who did not touch them.
   */
  private readonly changedSlots = new Set<number>();

  // The selection the user has just made. The panel shows it right away
  // and hands it over to the engine, which confirms it in the next panel
  // snapshot. The override is dropped once the engine reports the same
  // selection; until then it also covers an engine that never answers.
  private requested: { bank: Bank; buttons: number } | null = null;

  // The transport state the panel expects. A press that follows another
  // one right away must not be lost while the engine's answer is still
  // on its way, so the panel counts its own presses and follows the
  // engine again as soon as the engine has changed its state.
  private transportIntent = false;

  /**
   * The band of knobs is open in the classic mode.
   *
   * A hidden sequence opens it: the band of knobs belongs to the
   * advanced mode, and the sequence is the way into it for a user who
   * stays in the classic mode. The machine keeps playing the factory rhythms
   * and the printed card stays a print; only the band of knobs comes
   * out from under the black cover, and the knobs of the band are there
   * to be turned.
   *
    * The band stays open: the machine comes up the way the user left
    * it. The mode lever closes it again: the next trip through the
    * advanced mode and back leaves the band under the cover, and the
    * sequence has to be typed again to open it.
    */
  private bandUnlocked = false;

  /** The hidden sequence that opens the band of knobs. */
  private readonly bandCode = new BandCode(() => this.openBand());

  // The keys that are being held down. A pointer press belongs to the
  // pointer that made it, so a second finger can hold a second key.
  private readonly pointerPresses = new Map<number, KeyPress>();
  private readonly shortcutKeys = new Map<string, number>();

  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlash = -1;

  constructor(engine: PoppyEngine, host: HTMLElement) {
    this.engine = engine;
    this.savedControls = loadControlPositions();
    // A hidden sequence opens the band of knobs in the classic
    // mode, and the band stays open: the machine comes up the way the user
    // left it. The mode lever closes it again on the way back from the
    // advanced mode.
    this.bandUnlocked = this.savedControls.bandUnlocked === true;

    this.root = element('div', 'stage');

    // A problem that stops the engine from ever running is shown above the
    // machine: it is not a detail that belongs under the panel.
    this.banner = element('div', 'notice');
    this.banner.setAttribute('role', 'alert');
    this.banner.hidden = true;
    const bannerTitle = element('strong', 'notice-title');
    bannerTitle.textContent = 'The drum machine cannot run here';
    this.bannerText = element('p', 'notice-text');
    this.banner.append(bannerTitle, this.bannerText);
    this.root.append(this.banner);

    const unit = element('div', 'unit');
    const cabinet = element('div', 'cabinet');
    this.cabinet = cabinet;
    // The black cover lies over the metal band at the top of the cabinet:
    // it covers the write strip while the machine plays the factory
    // rhythms.
    const deck = element('div', 'deck');
    deck.setAttribute('aria-hidden', 'true');
    const faceplate = element('div', 'faceplate');
    faceplate.append(this.buildTopControls(), this.buildRhythmControls());
    this.extendedSection = this.buildExtendedSection();
    cabinet.append(deck, this.extendedSection, faceplate);
    unit.append(cabinet);
    this.root.append(unit);

    // The controls are put back where they were left, so the machine comes
    // up the way the user left it.
    this.restoreControlPositions();

    // The band of knobs was opened in the classic mode before: it is in
    // charge of the machine, and the machine takes the settings of the
    // memory position that is selected.
    if (this.bandUnlocked) {
      this.applyBandMemory(this.bandValues);
    }

    this.status = element('p', 'status');
    this.status.setAttribute('role', 'status');
    this.statusText = element('span', 'status-text');
    this.status.append(this.statusText);
    this.root.append(this.status);

    // The printed card sits under the machine and shows the pattern the
    // engine is playing. In the extended mode it also carries the name of
    // the user pattern and the accent row.
    this.card = new PatternGrid(engine, this.root, {
      names: this.userNames,
      onAccent: (column, accent) => {
        void this.writeStep(column, PATTERN_ACCENT_BIT, accent);
      },
      onToggle: (instrument, column, on) => {
        void this.writeStep(column, 1 << instrument, on);
      },
      onMeter: (timesig) => {
        void this.writeTimesig(timesig);
      },
      onRename: (rhythm) => {
        // The name of a pattern belongs to the pattern, so it is kept with
        // it: the work is not in the browser until the save button is
        // pressed.
        this.changedSlots.add(rhythm);
        this.markUnsaved();
      },
      onClear: () => this.clearPattern(),
      onCopy: () => this.copyPattern(),
      onPaste: () => this.pastePattern(),
      onExport: () => this.exportBank(),
      onImport: () => this.importBank(),
      onSave: () => this.savePatterns(),
    });

    host.append(this.root);

    // The machine is scaled down when the viewport is too small for it.
    this.fitter = new FitScaler(unit, [this.banner, this.status]);
    this.fitter.fit();

    for (const fader of this.faders) {
      fader.observe();
    }

    this.lamps = [
      this.root.querySelector<HTMLElement>('.lamp-a')!,
      this.root.querySelector<HTMLElement>('.lamp-b')!,
    ];

    this.wireEvents();
    this.renderSelection();

    // The card shows the pattern of the selection the machine starts with,
    // so the first rhythm is on the card before the first snapshot arrives.
    this.card.update(this.state);

    // The slots of the engine come up empty, so the rhythms of the two
    // banks are written into them: a slot that was not written keeps the
    // rhythm it came up with.
    for (const [index, rhythm] of DEFAULT_RHYTHMS.entries()) {
      this.engine.setUserPattern(index, rhythm);
    }

    // The patterns of the last visit are put back over them, so the work
    // of the user is used instead of the rhythms that came with the
    // machine.
    for (const [index, pattern] of loadUserPatterns()) {
      this.userPatterns.set(index, pattern);
      this.engine.setUserPattern(index, pattern);
    }

    engine.onPanel((state) => {
      this.render(state);
    });
    engine.onError((message) => {
      this.showStatus(message, true);
      const failure = this.engine.unavailable;
      if (failure !== null) {
        this.showBanner(failure);
      }
    });
    // A name that is written on the card is printed on the key bed right
    // away.
    this.userNames.onChange(() => this.renderSelection());
    this.showStatus('Press START to play', false);

    // A browser or an address that can never play is reported before
    // anything is pressed.
    const unavailable = engine.unavailable;
    if (unavailable !== null) {
      this.showBanner(unavailable);
    }
  }

  /**
   * The section of the faceplate that the black cover hides.
   *
   * It is a row of eight knobs, a square of four buttons that pick the
   * memory position of the knobs, and a button that puts the knobs of the
   * selected position back. The first knob carries the accent gain, the
    * second picks the instrument the six knobs behind it act on, and the
    * six carry the level, the place in the stereo field, the tone, the
    * cut-off, the decay and the reverb send of that instrument. The user
   * patterns are written on the pattern card, not on this strip.
   */
  private buildExtendedSection(): HTMLElement {
    const section = element('div', 'extended-section');
    const strip = element('div', 'write-strip');

    // The instrument the selector stands at is kept in the browser: the
    // machine comes up with the instrument it was left at.
    const storedInstrument = this.savedControls.instrument;
    const storedIndex = BAND_INSTRUMENTS.findIndex(
      (voice) => voice === storedInstrument,
    );
    this.bandSelector = storedIndex >= 0 ? storedIndex : 0;

    // The memory positions of the knobs. Every position keeps the accent
    // gain and the settings of every instrument the selector can pick. A
    // position that was not there at the last visit comes up with the
    // settings that belong to it: the first one is seeded with them, the
    // others come up with the defaults. They are built before the knobs,
    // so the knobs come up where the selected position says.
    const storedMemories = this.savedControls.memories ?? [];
    const storedMemory = this.savedControls.memory ?? 0;
    this.bandMemory =
      storedMemory >= 0 && storedMemory < BAND_MEMORY_COUNT ? storedMemory : 0;
    for (let index = 0; index < BAND_MEMORY_COUNT; index += 1) {
      const fallback = index === 0 ? seededBandMemory() : defaultBandMemory();
      const stored = storedMemories[index];
      this.bandMemories.push(
        stored ? this.mergeBandMemory(stored, fallback) : fallback,
      );
    }

    // The knob that carries the gain an accented column is played at. It
    // stands alone: it is the only knob of the band that acts on the
    // whole machine.
    this.accentKnob = new MiniKnob({
      label: 'ACCENT',
      ariaLabel: 'Accent gain',
      // The knob reaches below the level the accented columns come
      // with: it starts at 1.0, where an accented column is played
      // like the rest of it, and the machine comes up with 1.20.
      min: 1,
      max: 2,
      value: this.bandValues.accent,
      valueText: (value) => `${value.toFixed(2)}x`,
      onInput: (value) => {
        this.engine.setAccentGain(Math.round(value * Q16));
        // The panel moves the knobs itself when the source changes: that
        // is not the user giving a new setting.
        if (!this.restoring) {
          this.bandValues.accent = value;
          this.keepControlPositions();
        }
      },
    });
    strip.append(this.accentKnob.element);
    // The selector of the band: a knob with twelve detents, one for every
    // instrument except the three whose level the Additional Volume
    // faders on the faceplate carry. It travels freely under the finger
    // and slots itself into the nearest detent when it is released. It is
    // not a setting of its own: it picks the instrument the six knobs
    // behind it act on.
    this.selectorKnob = new MiniKnob({
      label: 'INSTRUMENT',
      ariaLabel: 'Instrument the parameter knobs act on',
      min: 0,
      max: BAND_INSTRUMENT_COUNT - 1,
      value: this.bandSelector,
      steps: BAND_INSTRUMENT_COUNT,
      valueText: (value) =>
        INSTRUMENT_NAMES[
          BAND_INSTRUMENTS[Math.round(value)] ?? 0
        ].toUpperCase(),
      onInput: (value) => {
        this.selectBandInstrument(Math.round(value));
      },
    });
    strip.append(this.selectorKnob.element);

    // The six parameter knobs of the band. Each of them acts on the
    // instrument the selector stands at, and a knob the engine takes
    // nothing from for that instrument stands dimmed.
    this.paramKnobs = bandParamKnobs(this.engine);
    this.paramKnobs.forEach((knob) => {
      const voice = this.bandInstrument;
      const bounds = knob.bounds(voice);
      const control = new MiniKnob({
        label: knob.label,
        ariaLabel: knob.ariaLabel,
        min: bounds.min,
        max: bounds.max,
        value: this.selectedInstrumentSettings()[knob.param],
        taper: knob.taper,
        enabled: knob.supported(voice),
        valueText: (value) => knob.valueText(value, this.bandInstrument),
        onInput: (value) => {
          this.writeBandParam(knob, value);
        },
      });
      this.paramControls.push(control);
      strip.append(control.element);
    });

    // The knobs stand where the settings of the selected position say.
    // The engine is not told: the machine comes up in the classic mode,
    // and the factory rhythms are played with the settings the machine
    // comes up with.
    this.applyBandPositions(this.bandValues);

    // The square of memory positions, and the button that puts the knobs
    // of the selected position back. They stand at the end of the row,
    // next to the knobs they belong to.
    const tail = element('div', 'write-strip-tail');
    const memories = element('div', 'write-strip-memories');
    memories.setAttribute('role', 'group');
    memories.setAttribute('aria-label', 'Memory position of the knobs');
    for (let index = 0; index < BAND_MEMORY_COUNT; index += 1) {
      const button = element('button', 'write-strip-memory');
      button.type = 'button';
      button.tabIndex = -1;
      button.textContent = String(index + 1);
      button.title = `Memory position ${index + 1} of the knobs`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        this.selectBandMemory(index);
      });
      this.bandMemoryButtons.push(button);
      memories.append(button);
    }
    tail.append(memories);

    // The button that puts the knobs of the selected memory position back
    // to their default values. It takes a long press: a brush past it must
    // not throw the settings away.
    const reset = element('button', 'write-strip-reset');
    reset.type = 'button';
    reset.tabIndex = -1;
    reset.title =
      'Hold to put the knobs of the selected memory position back to the defaults';
    reset.setAttribute('aria-label', reset.title);
    reset.textContent = 'RESET';
    this.armResetButton(reset);
    tail.append(reset);
    strip.append(tail);

    this.renderBandMemory();

    section.append(strip);
    return section;
  }

  /**
   * Put the controls back where they were left.
   *
   * The values that are put back are not written again: they are already
   * in the browser. The knobs of the band are not put back: the machine
   * starts in the preset mode, where the settings of the user patterns do
   * not belong.
   */
  private restoreControlPositions(): void {
    const { tempo, faders } = this.savedControls;
    if (tempo === undefined && faders === undefined) {
      return;
    }

    this.restoring = true;
    try {
      faders?.forEach((value, index) => {
        this.faders[index]?.set(value, true);
      });
      if (tempo !== undefined) {
        this.tempoKnob.set(tempo, true);
      }
    } finally {
      this.restoring = false;
    }
  }

  /**
   * Bring a memory position the browser kept back into the shape of
   * today.
   *
   * A value the browser kept from a machine with other ranges is brought
   * back into the range the knob takes it in, and a setting the browser
   * holds nothing of comes up with the value it was given: the seeded
   * values of the first position, and the default values of the others.
   */
  private mergeBandMemory(
    stored: StoredBandMemory,
    fallback: BandMemoryPosition,
  ): BandMemoryPosition {
    const instruments = fallback.instruments.map((settings, index) => {
      const kept = stored.instruments?.[index] ?? {};
      const limits = filterBounds(BAND_INSTRUMENTS[index] ?? 0);
      return {
        vol: clamp(kept.vol ?? settings.vol, 0, 2),
        pan: clamp(kept.pan ?? settings.pan, -1, 1),
        tone: clamp(kept.tone ?? settings.tone, 0.5, 2),
        filter: clamp(
          kept.filter ?? settings.filter,
          limits.min,
          limits.max,
        ),
        decay: clamp(kept.decay ?? settings.decay, 0.2, 5),
        send: clamp(kept.send ?? settings.send, 0, 1),
      };
    });
    return {
      accent: clamp(stored.accent ?? fallback.accent, 1, 2),
      instruments,
    };
  }

  /**
   * The knobs of the band follow the source.
   *
   * The factory rhythms are played with the settings the machine comes up
   * with, and the user patterns with the settings of the memory position
   * that is selected. The positions the user chose are kept either way:
   * the mode lever does not throw them away.
   *
   * The engine takes the settings whether the knobs stand at them or not:
   * a knob that already stands where the settings say does not tell the
   * engine anything by itself, and the settings still have to reach it.
   */
  private applyBandMemory(memory: BandMemoryPosition): void {
    this.engine.setAccentGain(Math.round(memory.accent * Q16));
    // The settings of every instrument the selector can reach for. The
    // engine takes the decay of every one of the twelve and a cut-off
    // from three of them only, and it ignores the rest.
    BAND_INSTRUMENTS.forEach((voice, index) => {
      const settings = memory.instruments[index];
      if (!settings) {
        return;
      }
      this.paramKnobs.forEach((knob) => {
        if (!knob.supported(voice)) {
          return;
        }
        // The engine takes the value the knob stands at: a memory position
        // that holds a value outside the range of this instrument is brought
        // into the range before it reaches the engine, so the sound and the
        // knob cannot disagree.
        const bounds = knob.bounds(voice);
        const value = clamp(settings[knob.param], bounds.min, bounds.max);
        knob.apply(value, voice);
      });
    });
    // The knobs stand where the settings say.
    this.applyBandPositions(memory);
  }

  /**
   * Move the knobs of the band to the settings they are given.
   *
   * The engine is not told: the knobs are put where a position says they
   * stand, and the engine keeps the settings it has until the source
   * changes.
   */
  private applyBandPositions(
    memory: BandMemoryPosition,
    moveSelector = true,
  ): void {
    this.accentKnob?.set(memory.accent, false);
    if (moveSelector) {
      this.selectorKnob?.set(this.bandSelector, false);
    }
    const voice = this.bandInstrument;
    const settings = memory.instruments[this.bandSelector];
    this.paramKnobs.forEach((knob, index) => {
      const control = this.paramControls[index];
      if (!control || !settings) {
        return;
      }
      const bounds = knob.bounds(voice);
      control.setBounds(bounds.min, bounds.max);
      control.setEnabled(knob.supported(voice));
      control.set(settings[knob.param], false);
    });
  }

  /**
   * Pick the instrument the six parameter knobs act on.
   *
   * The selector slots itself into one of twelve detents, and the six
   * knobs jump to the settings of that instrument. The engine is not
   * told: it already holds the settings of every instrument, and the
   * knobs were standing where the settings of the instrument before said.
   */
  private selectBandInstrument(index: number): void {
    const next = clamp(Math.round(index), 0, BAND_INSTRUMENT_COUNT - 1);
    if (next === this.bandSelector) {
      return;
    }
    this.bandSelector = next;
    // The selector is the knob the user is turning or has just turned, so
    // it is left where it stands: only the six knobs behind it move to the
    // settings of the instrument it now picks.
    this.applyBandPositions(this.bandValues, false);
    this.keepControlPositions();
  }

  /**
   * Write a parameter of the instrument the selector stands at.
   *
   * The value is written into the memory position that is selected, and
   * the engine takes it over. A knob the engine takes nothing from for
   * the instrument is left alone: it stands dimmed and takes no input.
   */
  private writeBandParam(knob: BandParamKnob, value: number): void {
    const voice = this.bandInstrument;
    if (!knob.supported(voice)) {
      return;
    }
    const bounds = knob.bounds(voice);
    const clamped = clamp(value, bounds.min, bounds.max);
    this.selectedInstrumentSettings()[knob.param] = clamped;
    knob.apply(clamped, voice);
    this.keepControlPositions();
  }

  /**
   * Pick the memory position the knobs stand at.
   *
   * The position brings its own settings to the knobs, and the engine
   * takes them over: the user patterns are played with the settings of
   * the position that is selected. The other positions keep the settings
   * they were given.
   */
  private selectBandMemory(index: number): void {
    if (index < 0 || index >= BAND_MEMORY_COUNT || index === this.bandMemory) {
      return;
    }
    this.bandMemory = index;
    this.renderBandMemory();
    // The knobs move to the settings of the position, and the engine
    // takes them over. The factory rhythms keep the settings the machine
    // comes up with, unless the band of knobs has been opened in the
    // classic mode.
    if (this.bandIsLive()) {
      this.applyBandMemory(this.bandValues);
    }
    this.keepControlPositions();
    this.showStatus(`Recovered memory position ${index + 1}`, false);
  }

  /**
   * Show which memory position is selected.
   *
   * The button of the position that is in use is pressed; the others are
   * not.
   */
  private renderBandMemory(): void {
    this.bandMemoryButtons.forEach((button, index) => {
      button.setAttribute(
        'aria-pressed',
        index === this.bandMemory ? 'true' : 'false',
      );
    });
  }

  /**
   * Keep the positions of the controls for the next visit.
   *
   * The write waits until the controls have come to rest, so a fader that
   * is dragged is written once and not on every step of the drag. The
   * knobs of the band are written with the positions the user gave them,
   * not with the ones the preset mode puts them at.
   */
  private keepControlPositions(): void {
    if (this.restoring) {
      return;
    }
    this.controlWriter.update({
      tempo: this.tempoKnob.current,
      faders: this.faders.map((fader) => fader.current),
      bandUnlocked: this.bandUnlocked,
      memoriesVersion: MEMORIES_VERSION,
      memories: this.bandMemories.map((memory) => ({
        accent: memory.accent,
        instruments: memory.instruments.map((settings) => ({ ...settings })),
      })),
      memory: this.bandMemory,
      instrument: this.bandInstrument,
    });
  }

  /**
   * Put the knobs of the selected memory position back to their defaults.
   *
   * The square button at the end of the band does it: it is the only way
   * back to the settings the machine comes up with. Only the position that
   * is selected is put back; the other ones keep the settings they were
   * given.
   *
   * The reset puts the defaults back and not the seeded values: a seed is
   * only the value a position starts with, and it is lost when the
   * position is put back.
   */
  /**
   * Make the reset button take a long press.
   *
   * The reset throws the settings of the memory position away, so a click
   * that was not meant must not do it: the reset runs only when the button
   * has been held for RESET_HOLD_MS with the pointer. The click the browser
   * fires when the button is let go is swallowed.
   */
  private armResetButton(button: HTMLButtonElement): void {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      button.classList.remove('is-holding');
    };
    const begin = (): void => {
      cancel();
      button.classList.add('is-holding');
      timer = setTimeout(() => {
        timer = null;
        button.classList.remove('is-holding');
        this.resetKnobs();
      }, RESET_HOLD_MS);
    };

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      button.setPointerCapture(event.pointerId);
      begin();
    });
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('click', (event) => {
      event.preventDefault();
    });
  }

  private resetKnobs(): boolean {
    const values = this.bandValues;
    values.accent = this.bandDefaults.accent;
    values.instruments = this.bandDefaults.instruments.map(
      (settings) => ({ ...settings }),
    );
    this.applyBandMemory(values);
    // The defaults are written to the browser, so the seeded values of the
    // position are lost: it comes up with the defaults from now on, and
    // not with the values it was seeded with.
    this.keepControlPositions();
    this.showStatus(
      `Memory position ${this.bandMemory + 1} reset to the default values`,
      false,
    );
    return true;
  }

  private buildTopControls(): HTMLElement {
    const top = element('div', 'top-controls');

    const brand = element('div', 'brand');
    const plate = element('div', 'brand-plate');
    plate.append(printedWord('POPPY 7', 'brand-mark'));
    brand.append(plate);

    const faderBank = element('div', 'fader-bank');
    const faderDefs: Array<{
      label: string;
      ariaLabel?: string;
      color: 'blue' | 'yellow';
      value: number;
      instrument?: number;
      target: 'balance' | 'volume' | 'gain';
      scale: 'right' | 'left' | 'end' | 'pair-end';
    }> = [
      // The three blue faders are the Additional Volume faders of the
      // machine: they move the tambourine, the guiro and the quijada.
      // Their top is the top of the fader of the original unit, so they
      // reach 1.0 and no further, and they come up in the middle of the
      // fader, at 0.5.
      {
        label: 'Quijada',
        color: 'blue',
        value: 50,
        instrument: 14,
        target: 'gain',
        scale: 'right',
      },
      {
        label: 'Guiro',
        color: 'blue',
        value: 50,
        instrument: 13,
        target: 'gain',
        scale: 'right',
      },
      {
        label: 'Tambourine',
        color: 'blue',
        value: 50,
        instrument: 12,
        target: 'gain',
        scale: 'end',
      },
      // The scale column on the volume fader is shared by the pair.
      {
        label: 'Volume',
        ariaLabel: 'Master volume',
        color: 'yellow',
        value: 50,
        target: 'volume',
        scale: 'left',
      },
      {
        label: 'Balance',
        ariaLabel: 'Balance',
        color: 'yellow',
        value: 50,
        target: 'balance',
        scale: 'pair-end',
      },
    ];

    const cluster = element('div', 'fader-cluster');
    for (const definition of faderDefs) {
      const fader = new Fader({
        label: definition.label,
        ariaLabel: definition.ariaLabel,
        color: definition.color,
        value: definition.value,
        scale: definition.scale,
        onInput: (value) => {
          if (definition.target === 'volume') {
            // The volume fader spans the panel's documented 0..4 range.
            // A fader position of 50 gives panel value 2.0, which the engine
            // turns into unity master gain via its fixed 0.5 factor.
            this.engine.setVolume(((value / 100) * 4 * Q16) | 0);
          } else if (definition.target === 'balance') {
            this.engine.setBalance(((value / 100) * Q16) | 0);
          } else if (definition.instrument !== undefined) {
            this.engine.setInstrumentGain(
              definition.instrument,
              ((value / 100) * Q16) | 0,
            );
          }
          this.keepControlPositions();
        },
      });
      this.faders.push(fader);
      if (definition.color === 'blue') {
        cluster.append(fader.element);
      } else {
        if (definition.target === 'volume') {
          fader.element.classList.add('fader--master');
        }
        faderBank.append(fader.element);
      }
    }
    faderBank.prepend(cluster);

    const tempo = new Knob({
      min: 40,
      max: 240,
      value: 120,
      onInput: (value) => {
        this.engine.setTempo(value);
        this.keepControlPositions();
      },
    });
    this.tempoKnob = tempo;

    // The switch that follows an external MIDI clock. It is a deliberate
    // addition to the panel: the machine has no such switch, and the knob
    // of the tempo gives the tempo to it only while no clock does. While
    // the clock is followed, the knob stands dimmed, the steps of the
    // machine follow the pulses of the clock, and the readout prints the
    // tempo the clock reports.
    const midiSync = element('button', 'midi-sync');
    midiSync.type = 'button';
    midiSync.tabIndex = -1;
    midiSync.setAttribute('role', 'switch');
    midiSync.setAttribute('aria-checked', 'false');
    midiSync.setAttribute('aria-label', 'Follow an external MIDI clock');
    midiSync.setAttribute(
      'title',
      'Follow an external MIDI clock: the machine plays and keeps step when it does, and the tempo knob is not used while it does',
    );
    midiSync.append(element('span', 'midi-sync-mark', 'MIDI SYNC'));
    midiSync.addEventListener('click', () => {
      void this.toggleMidiSync();
    });
    this.midiSync = midiSync;
    tempo.element.append(midiSync);

    const right = element('div', 'right-controls');
    const lampBlock = element('div', 'lamp-block');

    // The mode lever sits above the bank lever, in the same column: it
    // picks the factory rhythms or the user patterns. The bank lever
    // itself stands lower, beside the pilot lamps and the lines of
    // rhythm names they belong to, and is built with the rhythm section.
    this.modeSwitch = element('button', 'mode-switch');
    this.modeSwitch.type = 'button';
    this.modeSwitch.tabIndex = -1;
    this.modeSwitch.setAttribute('role', 'switch');
    this.modeSwitch.setAttribute('aria-checked', 'false');
    this.modeSwitch.setAttribute(
      'aria-label',
      'Pattern source: factory rhythms or user patterns',
    );
    const modeSlot = element('span', 'lever-slot');
    modeSlot.append(element('span', 'lever-arm'));
    this.modeSwitch.append(modeSlot);

    const modeMarks = element('div', 'mode-marks');
    modeMarks.setAttribute('aria-hidden', 'true');
    modeMarks.append(
      element('span', 'mode-mark mode-mark-preset', 'CLASSIC'),
      element('span', 'mode-mark mode-mark-user', 'ADVANCED'),
    );
    this.modeSwitch.append(modeMarks);
    lampBlock.append(this.modeSwitch);

    right.append(lampBlock);

    top.append(brand, faderBank, tempo.element, right);
    return top;
  }

  private buildRhythmControls(): HTMLElement {
    const section = element('div', 'rhythm-section');
    section.dataset.bank = '0';
    this.rhythmSection = section;

    const legend = element('div', 'rhythm-legend');
    const bankA = element('div', 'legend-row legend-a');
    const bankB = element('div', 'legend-row legend-b');
    for (let index = 0; index < 10; index += 1) {
      const nameA = element('span', 'legend-name', RHYTHM_NAMES[index] ?? '');
      const nameB = element('span', 'legend-name', RHYTHM_NAMES[index + 10] ?? '');
      bankA.append(nameA);
      bankB.append(nameB);
      this.legendNames[0]?.push(nameA);
      this.legendNames[1]?.push(nameB);
    }
    bankA.append(element('span', 'legend-spacer'));
    bankB.append(element('span', 'legend-spacer'));
    legend.append(bankA, bankB);
    this.legendRows.push(bankA, bankB);

    const keys = element('div', 'rhythm-keys');
    for (let index = 0; index < 10; index += 1) {
      const button = element('button', 'rhythm-key');
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('aria-pressed', 'false');
      const nameA = RHYTHM_NAMES[index] ?? '';
      const nameB = RHYTHM_NAMES[index + 10] ?? '';
      button.setAttribute('aria-label', `${nameA} / ${nameB}`);
      const tick = element('span', 'key-tick');
      tick.setAttribute('aria-hidden', 'true');
      button.append(tick);
      button.addEventListener('pointerdown', (event) =>
        this.onKeyPointerDown(index, button, event),
      );
      button.addEventListener('pointerup', (event) =>
        this.onKeyPointerUp(index, event),
      );
      button.addEventListener('pointercancel', (event) =>
        this.cancelPress(event.pointerId),
      );
      // A long press on a touch screen must not open the context menu.
      button.addEventListener('contextmenu', (event) => event.preventDefault());
      this.keyButtons.push(button);
      // The triangle that points at the key is printed on the faceplate,
      // not on the key: it stands still while the key travels.
      const slot = element('div', 'rhythm-slot');
      slot.dataset.pressed = 'false';
      slot.append(button);
      this.keySlots.push(slot);
      keys.append(slot);
    }

    // The start/stop switch is momentary: it is pressed down while the
    // finger is on it and springs back afterwards. The pilot lamp above
    // the legends tells whether the machine runs, `aria-pressed` tells it
    // to a screen reader.
    this.startStop = element('button', 'start-stop');
    this.startStop.type = 'button';
    this.startStop.tabIndex = -1;
    this.startStop.setAttribute('aria-pressed', 'false');
    this.startStop.setAttribute('aria-label', 'Start or stop rhythm');
    const startLabel = element('span', 'start-label', 'START');
    const runLed = element('span', 'run-led');
    runLed.setAttribute('aria-hidden', 'true');
    const stopLabel = element('span', 'stop-label', 'STOP');
    this.startStop.append(runLed, startLabel, stopLabel);
    keys.append(this.startStop);

    const keybed = element('div', 'keybed');
    keybed.append(keys);

    // The pilot lamps and the bank lever hang beside the two lines of
    // rhythm names: every lamp burns at the height of the line it
    // belongs to, black beside the upper line and red beside the lower
    // one, and the lever travels between the two lamps. The lamps stand
    // over the column the start/stop switch stands in, the way the print
    // of the machine does.
    const lamps = element('div', 'rhythm-lamps');
    const markA = element('span', 'lamp-mark lamp-mark-a');
    markA.setAttribute('aria-hidden', 'true');
    const markB = element('span', 'lamp-mark lamp-mark-b');
    markB.setAttribute('aria-hidden', 'true');
    this.bankSwitch = element('button', 'bank-switch');
    this.bankSwitch.type = 'button';
    this.bankSwitch.tabIndex = -1;
    this.bankSwitch.setAttribute('role', 'switch');
    this.bankSwitch.setAttribute('aria-checked', 'false');
    this.bankSwitch.setAttribute('aria-label', 'Rhythm bank A or B');
    const bankSlot = element('span', 'lever-slot');
    bankSlot.append(element('span', 'lever-arm'));
    this.bankSwitch.append(bankSlot);
    lamps.append(
      element('span', 'lamp lamp-a'),
      element('span', 'lamp lamp-b'),
      markA,
      markB,
      this.bankSwitch,
    );

    section.append(legend, keybed, lamps);
    return section;
  }

  private wireEvents(): void {
    // A press that ends outside the key is taken back.
    document.addEventListener('pointerup', (event) =>
      this.cancelPress(event.pointerId),
    );

    document.addEventListener(
      'keydown',
      (event) => this.onShortcutKeyDown(event),
      true,
    );
    document.addEventListener(
      'keyup',
      (event) => this.onShortcutKeyUp(event),
      true,
    );
    // The hidden sequence is typed with the arrow keys of the
    // keyboard.
    document.addEventListener('keydown', (event) =>
      this.onBandCodeKeyDown(event),
    );
    window.addEventListener('blur', () => this.shortcutKeys.clear());

    // The positions of the controls are written when they come to rest. A
    // page that goes away before that gets them written at once.
    window.addEventListener('pagehide', () => this.controlWriter.flush());

    this.bankSwitch.addEventListener('click', () => {
      this.selectBank(this.displayedBank() === 0 ? 1 : 0);
    });

    this.modeSwitch.addEventListener('click', () => {
      this.setSource(
        this.displayedSource() === PATTERN_SOURCE_USER
          ? PATTERN_SOURCE_PRESET
          : PATTERN_SOURCE_USER,
      );
    });

    // The switch travels while it is held down, so the pointer is
    // captured: the press belongs to the switch, even when the switch
    // moves out from under the pointer.
    this.startStop.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      this.startStop.setPointerCapture(event.pointerId);
    });
    this.startStop.addEventListener('click', () => this.toggleTransport());
  }

  /**
   * Point the machine at the factory rhythms or at the user patterns.
   *
   * The switch is immediate, the way the engine's own source switch is: the
   * selection keeps its meaning and is read against the other set of
   * patterns.
   */
  private setSource(source: PatternSource): void {
    if (this.displayedSource() === source) {
      return;
    }
    // The hidden sequence is typed in the classic mode: the lever
    // throws the source and the sequence starts over.
    this.bandCode.reset();
    // The extended mode is left behind: a pattern that was written but
    // not saved goes back to the contents the browser holds.
    if (source === PATTERN_SOURCE_PRESET) {
      void this.discardUnsavedPatterns();
      // Returning from the advanced mode closes the band of knobs again
      // when the hidden sequence had opened it in the classic mode: the
      // sequence has to be typed again to open it. The factory rhythms
      // are played with the settings the machine comes up with.
      if (this.bandUnlocked) {
        this.bandUnlocked = false;
        this.keepControlPositions();
      }
      this.applyBandMemory(this.bandDefaults);
    } else {
      // The user patterns are played with the settings of the memory
      // position that is selected.
      this.applyBandMemory(this.bandValues);
    }
    this.sourceRequested = source;
    this.renderSource();
    // The names on the key bed follow the source, so they are replaced
    // right away: the print of the machine changes with the lever.
    this.renderSelection();
    this.engine.setSource(source);
    this.showStatus(
      source === PATTERN_SOURCE_USER
        ? 'Advanced mode: the user patterns are played'
        : 'Classic mode: the factory rhythms are played',
      false,
    );
  }

  private displayedSource(): PatternSource {
    if (this.sourceRequested !== null) {
      return this.sourceRequested;
    }
    return this.state.source;
  }

  private toggleTransport(): void {
    if (this.startStop.disabled) {
      return;
    }
    // While the external clock is followed, the press does not start the
    // machine: it arms the replay, and the machine plays when the clock
    // starts and stops when the clock stops. Without the clock, the press
    // starts and stops the machine itself.
    if (this.midiSyncOn) {
      this.toggleArmedReplay();
      return;
    }
    if (this.transportIntent) {
      this.stopTransport();
      return;
    }
    this.startTransport();
  }

  /**
   * Arm the replay, or take the arming back.
   *
   * While the clock is followed, the press arms the replay: the machine
   * waits for the start of the clock, plays when the clock says start or
   * continue, and stops when it says stop. The waiting survives the stop,
   * so the machine plays again on the next start without a new press; the
   * press that comes while the replay is armed takes the waiting back,
   * and a machine that plays stops with it - the press answers to the
   * user, not to the clock.
   */
  private toggleArmedReplay(): void {
    if (!this.midiArmed) {
      this.midiArmed = true;
      this.renderArmed();
      this.showStatus('Replay is armed: it plays when the clock starts', false);
      return;
    }
    this.midiArmed = false;
    if (this.transportIntent) {
      this.stopTransport();
    }
    this.renderArmed();
    this.showStatus('Replay is not armed', false);
  }

  /** Show whether the replay waits for the MIDI clock's start. */
  private renderArmed(): void {
    this.startStop.classList.toggle('is-armed', this.midiArmed);
    // The screen reader is told what the switch does now: while the
    // replay is armed, the press works on the waiting and not on the
    // transport.
    const label = this.midiArmed
      ? 'Replay is armed: it waits for the start of the MIDI clock. A press takes the arming back'
      : 'Start or stop rhythm';
    if (this.startStop.getAttribute('aria-label') !== label) {
      this.startStop.setAttribute('aria-label', label);
    }
  }

  /**
   * Begin playing.
   *
   * The context is woken, the machine picks up the selection the keys
   * hold, and the transport runs from the first step of the cycle. It is
   * what the start of the switch does; the external MIDI clock lands
   * here too when its start or continue message arrives.
   */
  private startTransport(): void {
    if (this.transportIntent) {
      return;
    }
    this.transportIntent = true;
    this.startStop.disabled = true;
    this.engine
      .start()
      .catch((error: unknown) => {
        // The machine never came up, so it is not running either.
        this.transportIntent = false;
        this.showStatus(
          error instanceof Error ? error.message : String(error),
          true,
        );
      })
      .finally(() => {
        this.startStop.disabled = false;
      });
  }

  /**
   * Take the machine out of playing.
   *
   * The stop keeps the keys the way the user left them: a selection that
   * waits for the end of the cycle is given to the engine again
   * afterwards, so the stopped machine holds the keys that were pressed
   * and does not roll back to the rhythm that was sounding. It is what
   * the stop of the switch does; the external MIDI clock lands here too
   * when its stop message arrives.
   */
  private stopTransport(): void {
    if (!this.transportIntent) {
      return;
    }
    this.transportIntent = false;
    this.engine.stop();
    // The engine throws a selection away that waits for the end of the
    // cycle: its next snapshot would roll the keys back to the rhythm
    // that was sounding. The machine stops with the keys the way the
    // user left them instead — what was pressed, pending or not, is
    // given to the engine again, and a stopped transport takes it at
    // once.
    const bank = this.displayedBank();
    const buttons = this.displayedButtons();
    if (bank !== this.state.bank || buttons !== this.state.buttons) {
      this.requestSelection(bank, buttons);
    }
  }

  private selectBank(bank: Bank): void {
    if (this.displayedBank() === bank) {
      return;
    }
    this.requestSelection(bank, this.displayedButtons());
    // The selector has moved, and the move is a step of the sequence
    // that opens the band of knobs in the classic mode.
    if (!this.bandUnlocked && this.displayedSource() === PATTERN_SOURCE_PRESET) {
      this.bandCode.noteSelector(bank);
    }
  }

  /**
   * Follow an external MIDI clock, or hand the tempo back to the knob.
   *
   * While the clock is followed, its timing clock pulses drive the steps
   * of the machine: the engine is put under the external step clock - it
   * holds its playhead until a pulse arrives and advances one step at
   * every third or fourth pulse, the grid the selection plays on - so
   * the pattern position is a count of received pulses and cannot drift
   * against the clock. The tempo setting knob stands dimmed: it is not
   * usable, and its readout prints the tempo the clock reports. The
   * messages of the transport follow with it: a start or a continue
   * plays, and a stop takes the machine out. All of it only while the
   * clock is followed, because no input is read otherwise.
   *
   * When the clock is let go, the knob is the tempo source again: the
   * value it points at is given to the engine - which leaves the
   * external step clock and advances on its own from wherever the
   * clock-driven steps left the playhead - and it reads its own BPM
   * back. The way the switch stands is not kept between visits:
   * following a clock asks for the MIDI inputs of the browser, and it
   * asks only when the user wants it.
   */
  private async toggleMidiSync(): Promise<void> {
    if (this.midiSyncOn) {
      this.midi.disable();
      this.midiSyncOn = false;
      // The arming waited for the clock, and there is no clock to wait
      // for any more: the replay is taken out of it, and the press on the
      // switch plays the machine itself again.
      this.midiArmed = false;
      this.renderArmed();
      this.renderMidiSync();
      this.tempoKnob.setExternal(null);
      this.tempoKnob.setEnabled(true);
      // The knob is the tempo source again: the engine takes the value it
      // stands at, so the machine plays at the tempo the print says.
      this.engine.setExternalClock(false, this.tempoKnob.current);
      this.showStatus('External MIDI sync is off', false);
      return;
    }

    let inputs = 0;
    try {
      inputs = await this.midi.enable();
    } catch (error: unknown) {
      // The sync stays off: the tempo knob keeps its place.
      this.showStatus(
        error instanceof Error ? error.message : String(error),
        true,
      );
      return;
    }

    this.midiSyncOn = true;
    this.renderMidiSync();
    // The machine holds its playhead until the first pulse arrives, and
    // every step follows the pulses from then on.
    this.engine.setExternalClock(true, 0);
    this.tempoKnob.setEnabled(false);
    // The first clock pulse has not arrived yet: the readout says where
    // the tempo comes from, and the tempo of the clock replaces it.
    this.tempoKnob.setExternal('MIDI');
    this.showStatus(
      inputs > 0
        ? 'External MIDI sync is on: the clock drives the steps and the transport'
        : 'External MIDI sync is on, but no MIDI inputs are connected',
      false,
    );
  }

  /** Show whether the external MIDI clock is followed. */
  private renderMidiSync(): void {
    this.midiSync.setAttribute('aria-checked', this.midiSyncOn ? 'true' : 'false');
    this.midiSync.classList.toggle('is-on', this.midiSyncOn);
  }

  /**
   * An arrow of the keyboard was pressed.
   *
   * The arrow is a step of the hidden sequence, which opens the band
   * of knobs in the classic mode. The sequence is only typed in the
   * classic mode: in the advanced mode the band is open already.
   */
  private onBandCodeKeyDown(event: KeyboardEvent): void {
    if (
      this.bandUnlocked ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      this.isTypingTarget(event)
    ) {
      return;
    }
    if (this.displayedSource() !== PATTERN_SOURCE_PRESET) {
      // The sequence is only typed in the classic mode: in the advanced
      // mode the band of knobs is open already.
      return;
    }
    // The arrows are typed with the A/B selector at A.
    if (this.displayedBank() !== 0) {
      return;
    }
    if (this.bandCode.noteArrow(event.key)) {
      // The arrow is a step of the sequence: the page does not scroll.
      event.preventDefault();
    }
  }

  /**
   * The band of knobs comes out from under the black cover.
   *
   * The hidden sequence opens the band in the classic mode: the
   * machine keeps playing the factory rhythms and the printed card stays
   * a print, but the band of knobs is there and it works.
   */
  private openBand(): void {
    if (this.bandUnlocked) {
      return;
    }
    this.bandUnlocked = true;
    // The band is in charge of the machine: the settings of the memory
    // position that is selected are the settings of the machine.
    this.applyBandMemory(this.bandValues);
    this.renderSource();
    this.keepControlPositions();
    this.showStatus('The band of knobs is open in the classic mode', false);
  }

  /**
   * Whether the band of knobs is in charge of the machine.
   *
   * The band belongs to the advanced mode, and the hidden sequence
   * opens it in the classic mode as well. When the band is in charge, the
   * settings of the memory position that is selected are the settings of
   * the machine, and the knobs of the band move them.
   */
  private bandIsLive(): boolean {
    return (
      this.displayedSource() === PATTERN_SOURCE_USER || this.bandUnlocked
    );
  }

  private onShortcutKeyDown(event: KeyboardEvent): void {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      this.isTypingTarget(event)
    ) {
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) {
        this.toggleTransport();
      }
      return;
    }

    if (event.repeat) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === 'a' || key === 'b') {
      this.selectBank(key === 'a' ? 0 : 1);
      return;
    }

    if (key === 'e') {
      this.setSource(
        this.displayedSource() === PATTERN_SOURCE_USER
          ? PATTERN_SOURCE_PRESET
          : PATTERN_SOURCE_USER,
      );
      return;
    }

    const shortcut = rhythmShortcutFor(event);
    if (shortcut === null) {
      return;
    }

    // A key that is already held down is the same key, not a new one.
    for (const held of this.shortcutKeys.values()) {
      if (held === shortcut.index) {
        return;
      }
    }

    // A chord is two keys; a third key has nothing to latch.
    if (this.shortcutKeys.size >= MAX_SIMULTANEOUS_KEYS) {
      return;
    }

    this.shortcutKeys.set(shortcut.id, shortcut.index);
    if (this.shortcutKeys.size === 1) {
      this.applyShortPress(shortcut.index);
      return;
    }

    let mask = 0;
    for (const held of this.shortcutKeys.values()) {
      mask |= 1 << held;
    }
    this.requestSelection(this.displayedBank(), mask);
  }

  private onShortcutKeyUp(event: KeyboardEvent): void {
    const shortcut = rhythmShortcutFor(event);
    if (shortcut !== null) {
      this.shortcutKeys.delete(shortcut.id);
    }
    if (
      event.key !== ' ' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      this.isTypingTarget(event)
    ) {
      return;
    }
    event.preventDefault();
  }

  private isTypingTarget(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /**
   * A short press picks a single rhythm: the key that was pressed becomes
   * the only latched one. Among keys that are already latched the click
   * keeps the one that was pressed and releases the others. A key that is
   * latched on its own stays alone, and so does every other key: a click
   * on a lit key must not switch the machine off.
   */
  private applyShortPress(index: number): void {
    const buttons = this.displayedButtons();
    const bit = 1 << index;
    if (buttons === bit) {
      return;
    }
    this.requestSelection(this.displayedBank(), bit);
  }

  /**
   * A long press works on the selection: the key joins it, or leaves it
   * again, and the other keys keep their state.
   */
  private applyLongPress(index: number): void {
    const buttons = this.displayedButtons();
    const bit = 1 << index;
    const next =
      (buttons & bit) !== 0 ? buttons & ~bit : buttons | (1 << index);
    this.requestSelection(this.displayedBank(), next);
  }

  /**
   * A finger goes down on a key. The press belongs to that finger, so a
   * second finger can hold a second key at the same time.
   */
  private beginPointerPress(
    index: number,
    pointerId: number,
    footprint: Footprint,
  ): void {
    const press: KeyPress = {
      index,
      long: false,
      timer: 0,
      chord: false,
      footprint,
    };
    press.timer = setTimeout(() => {
      if (this.pointerPresses.get(pointerId) !== press) {
        return;
      }
      press.long = true;
      this.applyLongPress(index);
    }, LONG_PRESS_MS);
    this.pointerPresses.set(pointerId, press);

    // A second finger on another key makes a chord: the two keys latch
    // together, the way two keys pressed at the same time do on the
    // machine.
    if (this.pointerPresses.size === 2) {
      this.startChord();
    }
  }

  /**
   * Two keys are held down at the same time. They latch together and
   * make the whole selection, the way a chord on the machine does.
   */
  private startChord(): void {
    let mask = 0;
    for (const press of this.pointerPresses.values()) {
      clearTimeout(press.timer);
      press.chord = true;
      mask |= 1 << press.index;
    }
    this.requestSelection(this.displayedBank(), mask);
  }

  private endPointerPress(pointerId: number): KeyPress | null {
    const press = this.pointerPresses.get(pointerId);
    if (press === undefined) {
      return null;
    }
    clearTimeout(press.timer);
    this.pointerPresses.delete(pointerId);
    return press;
  }

  /** A press that was taken back, for example when the pointer wandered off. */
  private cancelPress(pointerId: number): void {
    this.endPointerPress(pointerId);
  }

  private onKeyPointerDown(
    index: number,
    button: HTMLButtonElement,
    event: PointerEvent,
  ): void {
    if (event.button !== 0) {
      return;
    }
    // A second finger on the same key is the same press, not a new one.
    for (const press of this.pointerPresses.values()) {
      if (press.index === index) {
        return;
      }
    }
    // A chord is two keys; a third finger has nothing to latch.
    if (this.pointerPresses.size >= MAX_SIMULTANEOUS_KEYS) {
      return;
    }
    // The key travels while it is held down, so the pointer is captured:
    // the press belongs to the key that was pressed down, even when the
    // key moves out from under the pointer.
    button.setPointerCapture(event.pointerId);
    this.beginPointerPress(index, event.pointerId, footprintOf(button));
  }

  private onKeyPointerUp(index: number, event: PointerEvent): void {
    const press = this.endPointerPress(event.pointerId);
    if (press === null || press.index !== index) {
      return;
    }
    // A chord has latched its keys already, and a long press has done
    // its work when the timer ran.
    if (press.chord || press.long) {
      return;
    }
    // A press that ends outside the key is taken back.
    if (
      press.footprint !== null &&
      !onFootprint(press.footprint, event.clientX, event.clientY)
    ) {
      return;
    }
    this.applyShortPress(index);
  }

  /**
   * Latch a selection. The panel shows it immediately, so the key lights
   * up on the click and not a round trip later.
   */
  private requestSelection(bank: Bank, buttons: number): void {
    this.requested = { bank, buttons };
    this.renderSelection();
    this.engine.select(bank, buttons);
  }

  private displayedBank(): Bank {
    if (this.requested !== null) {
      return this.requested.bank;
    }
    return this.state.pending ? this.state.pendingBank : this.state.bank;
  }

  private displayedButtons(): number {
    if (this.requested !== null) {
      return this.requested.buttons;
    }
    return this.state.pending ? this.state.pendingButtons : this.state.buttons;
  }

  /**
   * Write a bit into a step of the user patterns, or take it out again.
   *
   * The bit belongs to the pattern the card shows, so it is written into
   * every user pattern that is latched: the card shows the step of the
   * whole selection, and the step it marks is the same in all of them.
   */
  private async writeStep(
    column: number,
    bit: number,
    on: boolean,
  ): Promise<void> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return;
    }
    if (this.selectionIsCombined()) {
      return;
    }

    const slots = rhythmsFor(this.state.bank, this.state.buttons);
    for (const slot of slots) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return;
      }

      const notes = [...pattern.notes];
      const mask = notes[column] ?? 0;
      notes[column] = on
        ? (mask | bit) & 0xffff
        : mask & ~bit & 0xffff;

      const next: UserPattern = { ...pattern, notes };
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
      this.changedSlots.add(slot);
    }

    // The card carries the change at once: it sets or clears the bit in
    // the view it prints, and reads the view of the engine again after.
    this.card.applyStep(column, bit, on);
    // The card shows the pattern that plays, so it has to read it again.
    this.card.invalidate();
    // The pattern is not in the browser until the save button is pressed.
    this.markUnsaved();
  }

  /**
   * Write the meter of the card into the user patterns of the selection.
   *
   * The meter says how many of the steps of a bar the machine plays, and
   * the steps outside the bar are skipped. It is written as the time
   * signature of the meter, and the engine derives the mask of the steps
   * from it. It belongs to the whole selection, the way a step of the card
   * does: the signature is written into every user pattern that is
   * latched.
   */
  private async writeTimesig(timesig: TimeSignature): Promise<void> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return;
    }
    if (this.selectionIsCombined()) {
      return;
    }

    const meter = meterOfTimesig(timesig);
    if (meter === null) {
      return;
    }

    const slots = this.selectionSlots();
    if (slots.length === 0) {
      this.showStatus('Select a pattern before you set its meter', true);
      return;
    }

    for (const slot of slots) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return;
      }
      const next: UserPattern = { ...pattern, timesig };
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
      this.changedSlots.add(slot);
    }

    // The card shows the pattern that plays, so it has to read it again.
    this.card.invalidate();
    // The pattern is not in the browser until the save button is pressed.
    this.markUnsaved();
    this.showStatus(`The meter is ${meter.label}`, false);
  }

  /**
   * The pattern of a user slot.
   *
   * The panel keeps the patterns it knows; a slot it has not seen yet is
   * read from the engine.
   */
  private async userPattern(slot: number): Promise<UserPattern | null> {
    const known = this.userPatterns.get(slot);
    if (known !== undefined) {
      return known;
    }
    try {
      const pattern = await this.engine.getUserPattern(slot);
      this.userPatterns.set(slot, pattern);
      return pattern;
    } catch (error: unknown) {
      this.showStatus(
        error instanceof Error ? error.message : String(error),
        true,
      );
      return null;
    }
  }

  /** The user patterns that are latched, the ones the card shows. */
  private selectionSlots(): number[] {
    return rhythmsFor(this.state.bank, this.state.buttons);
  }

  /**
   * Whether the selection combines several rhythms.
   *
   * The engine composes a combined pattern from the rhythms that are
   * latched, so it is a display and not a pattern that can be written on.
   */
  private selectionIsCombined(): boolean {
    return this.selectionSlots().length > 1;
  }

  /**
   * Copy the pattern of the selection to the clipboard.
   *
   * The clipboard is a temporary one and it holds the notes of the
   * pattern: the hits and the accents. A pattern that is copied and
   * pasted comes back the way it was.
   */
  private async copyPattern(): Promise<boolean> {
    if (
      this.displayedSource() !== PATTERN_SOURCE_USER ||
      this.selectionIsCombined()
    ) {
      return false;
    }

    const slots = this.selectionSlots();
    if (slots.length === 0) {
      this.showStatus('Select a pattern to copy', true);
      return false;
    }

    const notes = new Array<number>(PATTERN_COLUMNS).fill(0);
    let found = false;
    for (const slot of slots) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return false;
      }
      found = true;
      for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
        notes[column] =
          ((notes[column] ?? 0) | (pattern.notes[column] ?? 0)) & 0xffff;
      }
    }
    if (!found) {
      this.showStatus('Select a pattern to copy', true);
      return false;
    }

    this.clipboard = notes;
    this.card.setClipboard(true);
    this.showStatus('The pattern is copied', false);
    return true;
  }

  /**
   * Write the clipboard into the pattern of the selection.
   *
   * The data belongs to the whole selection, the way a step of the card
   * does: it is written into every user pattern that is latched.
   */
  private async pastePattern(): Promise<boolean> {
    if (
      this.displayedSource() !== PATTERN_SOURCE_USER ||
      this.selectionIsCombined()
    ) {
      return false;
    }

    const notes = this.clipboard;
    if (notes === null) {
      this.showStatus('There is nothing to paste', true);
      return false;
    }

    const slots = this.selectionSlots();
    if (slots.length === 0) {
      this.showStatus('Select a pattern to paste into', true);
      return false;
    }

    for (const slot of slots) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return false;
      }
      const next: UserPattern = { ...pattern, notes: [...notes] };
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
      this.changedSlots.add(slot);
    }

    this.card.invalidate();
    this.markUnsaved();
    this.showStatus('The pattern is pasted', false);
    return true;
  }

  /**
   * Empty the pattern of the selection.
   *
   * An empty pattern is a full 64-column grid with every column enabled
   * and no instrument in it: the pattern the engine starts with.
   */
  private async clearPattern(): Promise<boolean> {
    if (
      this.displayedSource() !== PATTERN_SOURCE_USER ||
      this.selectionIsCombined()
    ) {
      return false;
    }

    const slots = this.selectionSlots();
    if (slots.length === 0) {
      this.showStatus('Select a pattern to clear', true);
      return false;
    }

    for (const slot of slots) {
      const next = emptyUserPattern();
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
      this.changedSlots.add(slot);
    }

    this.card.invalidate();
    this.markUnsaved();
    this.showStatus('The pattern is cleared', false);
    return true;
  }

  /**
   * The ten user patterns of a bank.
   *
   * A bank is one bank of the key bed: the ten slots that stand behind its
   * ten rhythm keys.
   */
  private bankSlots(bank: Bank): number[] {
    return rhythmsFor(bank, (1 << RHYTHM_BUTTON_COUNT) - 1);
  }

  /**
   * Write the whole bank of the selection to a file.
   *
   * The file holds the ten rhythms of the bank the lever stands on, with
   * their names, so the bank can be put back on another machine as it was.
   */
  private async exportBank(): Promise<boolean> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return false;
    }

    const bank = this.displayedBank();
    const patterns = [];
    for (const slot of this.bankSlots(bank)) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return false;
      }
      patterns.push(patternToFile(pattern, this.userNames.name(slot)));
    }

    downloadBankFile(buildBankFile(bank, patterns));
    this.showStatus(`Bank ${bank === 1 ? 'B' : 'A'} is written to a file`, false);
    return true;
  }

  /**
   * Read a whole bank of rhythms from a file into the bank of the
   * selection.
   *
   * The ten rhythms of the file go into the ten slots of the bank the
   * lever stands on, with their names. The bank that was there is thrown
   * away by it, and the work is not in the browser until the save button
   * is pressed.
   */
  private async importBank(): Promise<boolean> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return false;
    }

    let file: BankFile | null = null;
    try {
      file = await chooseBankFile();
    } catch (error: unknown) {
      this.showStatus(
        error instanceof Error ? error.message : String(error),
        true,
      );
      return false;
    }
    if (file === null) {
      // The dialog was let go without a file.
      return false;
    }

    const bank = this.displayedBank();
    const rhythms = file.patterns;
    const names = new Map<number, string>();
    this.bankSlots(bank).forEach((slot, index) => {
      const pattern = rhythms[index];
      if (pattern === undefined) {
        return;
      }
      const next = patternFromFile(pattern);
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
      this.changedSlots.add(slot);
      names.set(
        slot,
        pattern.name.trim() === '' ? defaultUserName(slot) : pattern.name,
      );
    });

    this.userNames.setMany(names);
    // The card shows the patterns that play, so it has to read them again.
    this.card.invalidate();
    // The bank is not in the browser until the save button is pressed.
    this.markUnsaved();
    this.showStatus(`Bank ${bank === 1 ? 'B' : 'A'} is imported`, false);
    return true;
  }

  /**
   * Keep the user patterns in the browser.
   *
   * The patterns are written when the save button is pressed and not
   * before: a pattern that is being written is not lost, but it is also
   * not in the browser yet. The names of the patterns are kept with them.
   *
   * Only the slots that were written are kept: a slot that was not
   * touched keeps the rhythm the machine comes up with, and the browser
   * does not hold a copy of it.
   */
  private savePatterns(): boolean {
    if (
      this.displayedSource() !== PATTERN_SOURCE_USER ||
      this.selectionIsCombined()
    ) {
      return false;
    }

    const saved = loadUserPatterns();
    for (const slot of this.changedSlots) {
      const pattern = this.userPatterns.get(slot);
      if (pattern !== undefined) {
        saved.set(slot, pattern);
      }
    }

    saveUserPatterns(saved);
    this.userNames.save();
    this.changedSlots.clear();
    this.patternsUnsaved = false;
    this.card.setUnsaved(false);
    this.showStatus('The patterns are kept in the browser', false);
    return true;
  }

  /** The pattern has changed and is not in the browser yet. */
  private markUnsaved(): void {
    this.patternsUnsaved = true;
    this.card.setUnsaved(true);
  }

  /**
   * The patterns that were written but not saved go back to the contents
   * the browser holds.
   *
   * The extended mode is left behind, and the work that was not kept with
   * the save button is gone: a slot that was never saved goes back to the
   * rhythm the machine comes up with. The names of the patterns go back
   * with them: a name belongs to the pattern it names.
   */
  private discardUnsavedPatterns(): void {
    if (!this.patternsUnsaved) {
      return;
    }
    this.patternsUnsaved = false;

    const saved = loadUserPatterns();
    for (const slot of this.changedSlots) {
      const restored = saved.get(slot) ?? this.defaultUserPattern(slot);
      if (restored === null) {
        continue;
      }
      this.userPatterns.set(slot, restored);
      this.engine.setUserPattern(slot, restored);
    }
    this.changedSlots.clear();

    // The names go back to the names the browser holds.
    this.userNames.restore();

    // The card shows the patterns that play, so it has to read them again.
    this.card.setUnsaved(false);
    this.card.invalidate();
    this.showStatus('The changes that were not saved are gone', false);
  }

  /**
   * The rhythm a user slot comes up with.
   *
   * It is the rhythm of the machine and not the pattern in the slot: the
   * panel puts a slot back the way it came with it.
   */
  private defaultUserPattern(slot: number): UserPattern | null {
    return defaultRhythm(slot);
  }

  /**
   * The black cover and the mode lever follow the source: in the extended
   * mode the cover slides up and the write strip is there.
   *
   * The hidden sequence opens the band of knobs in the classic mode
   * as well: the cover slides up there too, and the knobs of the band are
   * there to be turned. The source does not change: the factory rhythms
   * keep playing and the printed card stays a print.
   */
  private renderSource(): void {
    const extended = this.displayedSource() === PATTERN_SOURCE_USER;
    const bandOpen = extended || this.bandUnlocked;
    this.cabinet.classList.toggle('is-extended', extended);
    this.cabinet.classList.toggle('is-unlocked', this.bandUnlocked);
    this.modeSwitch.setAttribute(
      'aria-checked',
      extended ? 'true' : 'false',
    );
    if (bandOpen) {
      this.extendedSection.removeAttribute('inert');
    } else {
      this.extendedSection.setAttribute('inert', '');
    }
  }

  /**
   * The keys whose selection the engine has not taken over yet.
   *
   * While the transport runs, a new selection waits for the end of the
   * cycle, so the marker of a key that is still waiting pulses until the
   * pattern it belongs to starts. A stopped transport takes the selection
   * at once, and then nothing waits.
   */
  private pendingKeys(): Set<number> {
    const pending = new Set<number>();
    if (!this.state.running) {
      return pending;
    }
    const applied = new Set(rhythmsFor(this.state.bank, this.state.buttons));
    const shown = rhythmsFor(this.displayedBank(), this.displayedButtons());
    for (const rhythm of shown) {
      if (!applied.has(rhythm)) {
        pending.add(rhythm % RHYTHM_BUTTON_COUNT);
      }
    }
    return pending;
  }

  private render(state: PanelState): void {
    const wasRunning = this.state.running;
    this.state = state;

    // The engine has changed its state, so it has taken over the last
    // press. A snapshot that carries the state it had before the press
    // says nothing about it and leaves the panel's own opinion alone.
    if (wasRunning !== state.running) {
      this.transportIntent = state.running;
    }

    // The engine has caught up with the request when it reports the same
    // selection; from then on the panel follows the engine again.
    if (this.requested !== null) {
      const engineBank = state.pending ? state.pendingBank : state.bank;
      const engineButtons = state.pending ? state.pendingButtons : state.buttons;
      if (
        engineBank === this.requested.bank &&
        engineButtons === this.requested.buttons
      ) {
        this.requested = null;
      }
    }

    // The same goes for the source: the engine confirms the switch with
    // the next snapshot.
    if (this.sourceRequested !== null && state.source === this.sourceRequested) {
      this.sourceRequested = null;
    }

    this.card.update(state);
    this.renderSelection();

    this.startStop.setAttribute('aria-pressed', state.running ? 'true' : 'false');

    if (!state.running) {
      // Stopped, the lamps are dark: the bank is shown by the lever and
      // by the legend, not by a burning lamp.
      this.clearFlash();
      this.setLamps(null);
    } else if (state.flashCount !== this.lastFlash) {
      this.flash(state.bank);
    } else if (!wasRunning) {
      this.setLamps(null);
    }

    this.lastFlash = state.flashCount;

    if (wasRunning !== state.running) {
      this.showStatus(
        state.running ? 'Rhythm running' : 'Rhythm stopped',
        false,
      );
    }
  }

  /** The bank lever, the latched keys and the printed legend. */
  private renderSelection(): void {
    const bank = this.displayedBank();
    const buttons = this.displayedButtons();
    const pending = this.pendingKeys();

    this.rhythmSection.dataset.bank = String(bank);

    this.keyButtons.forEach((button, index) => {
      const latched = (buttons & (1 << index)) !== 0;
      button.setAttribute('aria-pressed', latched ? 'true' : 'false');
      // A key that waits for the end of the cycle pulses until the pattern
      // it belongs to is the one that plays.
      button.classList.toggle('is-pending', latched && pending.has(index));
      // In the extended mode the key bed carries the names of the user
      // patterns instead of the names of the factory rhythms.
      const label = `${this.keyName(index)} / ${this.keyName(
        index + RHYTHM_BUTTON_COUNT,
      )}`;
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
      }
      // The triangle on the faceplate tells which key belongs to the
      // selection. It stands still, so only its ink changes.
      const slot = this.keySlots[index];
      if (slot && slot.dataset.pressed !== (latched ? 'true' : 'false')) {
        slot.dataset.pressed = latched ? 'true' : 'false';
      }
    });

    this.legendNames.forEach((row, rowIndex) => {
      row.forEach((name, index) => {
        const latched = rowIndex === bank && (buttons & (1 << index)) !== 0;
        name.classList.toggle('is-selected', latched);
      });
    });

    // The names on the key bed follow the source. When it changes, they
    // are replaced with a fade, so the print of the machine does not
    // change in one hard cut.
    const source = this.displayedSource();
    if (source !== this.legendSource) {
      this.legendSource = source;
      this.fadeLegendNames();
    } else if (!this.legendFading) {
      this.writeLegendNames();
    }

    this.legendRows[0]?.classList.toggle('active', bank === 0);
    this.legendRows[1]?.classList.toggle('active', bank === 1);
    this.bankSwitch.setAttribute('aria-checked', bank === 1 ? 'true' : 'false');

    this.renderSource();
  }

  /**
   * The names printed on the key bed.
   *
   * In the preset mode the key bed carries the names of the factory
   * rhythms, in the extended mode the names of the user patterns.
   */
  private writeLegendNames(): void {
    this.legendNames.forEach((row, rowIndex) => {
      row.forEach((name, index) => {
        const text = this.keyName(rowIndex * RHYTHM_BUTTON_COUNT + index);
        if (name.textContent !== text) {
          name.textContent = text;
        }
      });
    });
  }

  /**
   * Replace the names on the key bed with a short fade.
   *
   * The names of the factory rhythms and the names of the user patterns
   * take each other's place. A plain swap is harsh, so the old names fade
   * out, the new ones are written while they cannot be seen, and they come
   * in again.
   */
  private fadeLegendNames(): void {
    this.clearLegendTimer();

    const names = this.legendNames.flat();

    this.legendFading = true;
    for (const name of names) {
      name.classList.add('is-fading');
    }
    this.legendTimer = setTimeout(() => {
      this.legendTimer = null;
      this.legendFading = false;
      this.writeLegendNames();
      for (const name of names) {
        name.classList.remove('is-fading');
      }
    }, LEGEND_FADE_MS);
  }

  private clearLegendTimer(): void {
    if (this.legendTimer !== null) {
      clearTimeout(this.legendTimer);
      this.legendTimer = null;
    }
  }

  /**
   * The name of a key: the name of the factory rhythm, or the name of the
   * user pattern in the extended mode.
   */
  private keyName(slot: number): string {
    if (this.displayedSource() === PATTERN_SOURCE_USER) {
      return this.userNames.name(slot);
    }
    return RHYTHM_NAMES[slot] ?? '';
  }

  private flash(bank: Bank): void {
    this.clearFlash();
    this.setLamps(bank);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.setLamps(null);
    }, 120);
  }

  private clearFlash(): void {
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
  }

  private setLamps(bank: Bank | null): void {
    this.lamps[0].classList.toggle('on', bank === 0);
    this.lamps[1].classList.toggle('on', bank === 1);
  }

  private showStatus(message: string, error: boolean): void {
    this.statusText.textContent = message;
    this.status.classList.toggle('error', error);
    // A failure needs to be announced; the running state does not.
    this.status.setAttribute('role', error ? 'alert' : 'status');
  }

  private showBanner(message: string): void {
    this.bannerText.textContent = message;
    this.banner.hidden = false;
  }
}
