import type { PoppyEngine } from '../audio/engine';
import {
  INITIAL_PANEL_STATE,
  INSTR_HIHAT,
  INSTR_PERCUSSION,
  INSTR_SNARE_1,
  PATTERN_ACCENT_BIT,
  PATTERN_COLUMNS,
  PATTERN_SOURCE_PRESET,
  PATTERN_SOURCE_USER,
  RHYTHM_BUTTON_COUNT,
  RHYTHM_NAMES,
  VOICE_PARAM,
  type Bank,
  type PanelState,
  type PatternSource,
  type UserPattern,
} from '../audio/protocol';
import { FitScaler } from './fit';
import {
  ControlWriter,
  loadControlPositions,
  type ControlPositions,
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
import { loadUserPatterns, saveUserPatterns } from './user-store';
import { UserNames, defaultUserName } from './user-names';
import { meterByLabel, meterMask } from './meter';

const Q16 = 65536;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The knobs of the band under the black cover.
 *
 * The first seven reach into the engine and move the parameters it holds
 * fixed today: the gain an accented column is played at, the level, the
 * decay and the cutoff of the snare, the level and the cutoff of the
 * hi-hat and the level of the percussion. The knob after them spreads the
 * instruments over the stereo field.
 */
const PANEL_KNOBS = 8;

/**
 * How many memory positions the band of knobs has.
 *
 * A memory position keeps the settings of the knobs: the square of four
 * buttons at the end of the band picks the position that is in use, and
 * the button next to it puts the knobs of that position back where they
 * come up in. The other positions keep the settings they were given.
 */
const BAND_MEMORY_COUNT = 4;

/**
 * The knobs of the band that have a function.
 *
 * Every one of them stands where the engine stands when it comes up, so
 * the machine sounds the same until a knob is moved.
 */
interface BandKnob {
  /**
   * The name the knob is known by.
   *
   * It tells the knobs apart when their positions are kept in the browser:
   * a knob that changes its function does not come up with the position of
   * the knob that stood there before.
   */
  id: string;
  /** The printed caption. */
  label: string;
  /** The name the screen reader gets. */
  ariaLabel: string;
  /** The smallest value the knob takes. */
  min: number;
  /** The largest value the knob takes. */
  max: number;
  /** The value the knob stands at when the machine comes up. */
  value: number;
  /** What the value is called. */
  valueText: (value: number) => string;
  /** Whether the knob reads out its value. */
  showReadout?: boolean;
  /** What the knob does when it is moved. */
  onInput: (value: number) => void;
}

function bandKnobs(engine: PoppyEngine): BandKnob[] {
  return [
    {
      id: 'accent',
      label: 'ACCENT',
      ariaLabel: 'Accent gain',
      min: 1,
      max: 2,
      value: 1.2,
      valueText: (value) => `${value.toFixed(2)}x`,
      onInput: (value) => {
        engine.setAccentGain(Math.round(value * Q16));
      },
    },
    {
      id: 'sn1-vol',
      label: 'SN1 VOL',
      ariaLabel: 'Snare 1 level',
      min: 0,
      max: 2,
      value: 1,
      valueText: (value) => `${Math.round(value * 100)}%`,
      onInput: (value) => {
        engine.setVoiceParam(
          INSTR_SNARE_1,
          VOICE_PARAM.volume,
          Math.round(value * Q16),
        );
      },
    },
    {
      id: 'sn1-decay',
      label: 'SN1 DECAY',
      ariaLabel: 'Snare 1 decay',
      min: 20,
      max: 1000,
      value: 400,
      valueText: (value) => `${Math.round(value)} ms`,
      onInput: (value) => {
        engine.setVoiceParam(
          INSTR_SNARE_1,
          VOICE_PARAM.decay,
          Math.round(value * 1000),
        );
      },
    },
    {
      id: 'sn1-cutoff',
      label: 'SN1 CUTOFF',
      ariaLabel: 'Snare 1 cutoff',
      min: 200,
      max: 12000,
      value: 5500,
      valueText: (value) => `${(value / 1000).toFixed(1)} kHz`,
      onInput: (value) => {
        engine.setVoiceParam(
          INSTR_SNARE_1,
          VOICE_PARAM.cutoff,
          Math.round(value),
        );
      },
    },
    {
      id: 'hh-vol',
      label: 'HH VOL',
      ariaLabel: 'Hi-hat level',
      min: 0,
      max: 2,
      value: 1,
      valueText: (value) => `${Math.round(value * 100)}%`,
      onInput: (value) => {
        engine.setVoiceParam(
          INSTR_HIHAT,
          VOICE_PARAM.volume,
          Math.round(value * Q16),
        );
      },
    },
    {
      id: 'hh-cutoff',
      label: 'HH CUTOFF',
      ariaLabel: 'Hi-hat cutoff',
      min: 1000,
      max: 20000,
      value: 10000,
      valueText: (value) => `${(value / 1000).toFixed(1)} kHz`,
      onInput: (value) => {
        engine.setVoiceParam(INSTR_HIHAT, VOICE_PARAM.cutoff, Math.round(value));
      },
    },
    {
      id: 'perc-vol',
      label: 'PERC VOL',
      ariaLabel: 'Percussion level',
      min: 0,
      max: 2,
      value: 1,
      valueText: (value) => `${Math.round(value * 100)}%`,
      onInput: (value) => {
        // The knob moves the whole group of percussion at once: the small
        // bongo, the large bongo, the conga, the cowbell, the claves and
        // the rimshot.
        const level = Math.round(value * Q16);
        for (const instrument of INSTR_PERCUSSION) {
          engine.setVoiceParam(instrument, VOICE_PARAM.volume, level);
        }
      },
    },
    {
      id: 'spread',
      label: 'PAN SPREAD',
      ariaLabel: 'Stereo spread of the instruments',
      min: -1,
      max: 1,
      value: 0,
      valueText: (value) => {
        const percent = Math.round(Math.abs(value) * 100);
        if (percent === 0) {
          return '0%';
        }
        return `${value < 0 ? '-' : '+'}${percent}%`;
      },
      onInput: (value) => {
        // The knob spreads the instruments over the stereo field: every
        // instrument moves from the centre towards the side it belongs
        // to, and below zero the whole field is mirrored.
        engine.setStereoSpread(value);
      },
    },
  ];
}

/**
 * How long a key has to be held down before the press counts as a long
 * press. A short press picks a single rhythm, a long press adds to the
 * selection.
 */
const LONG_PRESS_MS = 500;

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
   * The place the key was when the finger went down. A press of the
   * keyboard has no place, so it has none either.
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

/**
 * The little arrow on the reset button of the band.
 *
 * It is the mark of a control that puts things back the way they came.
 */
function resetIcon(className: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  );
  svg.append(path);
  return svg;
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
 * The pattern the engine starts with: a full 64-column grid with every
 * column enabled and no instrument in it.
 */
function emptyUserPattern(): UserPattern {
  return {
    notes: new Array<number>(PATTERN_COLUMNS).fill(0),
    enableLo: -1,
    enableHi: -1,
    period: PATTERN_COLUMNS,
    triplet: false,
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
    this.element.tabIndex = 0;
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
      this.element.focus();
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
    this.element.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1;
      let next: number | null = null;

      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        next = this.value + step;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        next = this.value - step;
      } else if (event.key === 'PageUp') {
        next = this.value + 10;
      } else if (event.key === 'PageDown') {
        next = this.value - 10;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = 100;
      }

      if (next !== null) {
        event.preventDefault();
        this.set(next, true);
      }
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
    this.dial.tabIndex = 0;
    this.dial.setAttribute('role', 'slider');
    this.dial.setAttribute('aria-label', 'Tempo');
    this.dial.setAttribute('aria-valuemin', String(this.min));
    this.dial.setAttribute('aria-valuemax', String(this.max));
    // The knob body stays put; only the white index line sweeps, so the
    // knurling and the drop shadow never make the dial look off-centre.
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

    let dragStartY = 0;
    let dragStartValue = 0;
    this.dial.addEventListener('pointerdown', (event) => {
      dragStartY = event.clientY;
      dragStartValue = this.value;
      this.dial.setPointerCapture(event.pointerId);
      this.dial.focus();
    });
    this.dial.addEventListener('pointermove', (event) => {
      if (!this.dial.hasPointerCapture(event.pointerId)) {
        return;
      }
      // The knob turns with the finger, so the drag is measured in the
      // size the knob is seen at, not in the size it is laid out in.
      const delta = (dragStartY - event.clientY) / this.scale() * 0.85;
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
        event.preventDefault();
        this.set(this.value + (event.deltaY < 0 ? 2 : -2), true);
      },
      { passive: false },
    );
    this.dial.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1;
      let next: number | null = null;

      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        next = this.value + step;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        next = this.value - step;
      } else if (event.key === 'PageUp') {
        next = this.value + 10;
      } else if (event.key === 'PageDown') {
        next = this.value - 10;
      } else if (event.key === 'Home') {
        next = this.min;
      } else if (event.key === 'End') {
        next = this.max;
      }

      if (next !== null) {
        event.preventDefault();
        this.set(next, true);
      }
    });

    this.render();
  }

  set(value: number, notify: boolean): void {
    this.value = clamp(Math.round(value), this.min, this.max);
    this.render();
    if (notify) {
      this.onInput(this.value);
    }
  }

  /** The value the knob stands at. */
  get current(): number {
    return this.value;
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
    this.dial.setAttribute('aria-valuetext', `${this.value} beats per minute`);
    this.readout.value = `${this.value} BPM`;
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
  private readonly min: number;
  private readonly max: number;
  private readonly onInput: (value: number) => void;
  private readonly valueText: (value: number) => string;
  private readonly showReadout: boolean;

  constructor(options: MiniKnobOptions) {
    this.min = options.min;
    this.max = options.max;
    this.value = clamp(options.value, this.min, this.max);
    this.onInput = options.onInput;
    this.valueText = options.valueText;
    this.showReadout = options.showReadout ?? true;

    this.element = element('div', 'mini-knob');
    this.dial = element('div', 'mini-dial');
    this.dial.tabIndex = 0;
    this.dial.setAttribute('role', 'slider');
    this.dial.setAttribute('aria-label', options.ariaLabel);
    this.dial.setAttribute('aria-valuemin', String(this.min));
    this.dial.setAttribute('aria-valuemax', String(this.max));

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

    let dragStartY = 0;
    let dragStartValue = 0;
    this.dial.addEventListener('pointerdown', (event) => {
      dragStartY = event.clientY;
      dragStartValue = this.value;
      this.dial.setPointerCapture(event.pointerId);
      this.dial.focus();
    });
    this.dial.addEventListener('pointermove', (event) => {
      if (!this.dial.hasPointerCapture(event.pointerId)) {
        return;
      }
      // The knob turns with the finger, so the drag is measured in the
      // size the knob is seen at, not in the size it is laid out in.
      const travel = (dragStartY - event.clientY) / this.scale();
      this.set(
        dragStartValue + (travel / MINI_KNOB_TRAVEL) * (this.max - this.min),
        true,
      );
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
        event.preventDefault();
        const step = this.step() * (event.shiftKey ? 10 : 1);
        this.set(this.value + (event.deltaY < 0 ? step : -step), true);
      },
      { passive: false },
    );
    this.dial.addEventListener('keydown', (event) => {
      const step = this.step() * (event.shiftKey ? 10 : 1);
      let next: number | null = null;
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
        next = this.value + step;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
        next = this.value - step;
      } else if (event.key === 'PageUp') {
        next = this.value + step * 10;
      } else if (event.key === 'PageDown') {
        next = this.value - step * 10;
      } else if (event.key === 'Home') {
        next = this.min;
      } else if (event.key === 'End') {
        next = this.max;
      }

      if (next !== null) {
        event.preventDefault();
        this.set(next, true);
      }
    });

    this.render();
  }

  /** The value the knob stands at. */
  get current(): number {
    return this.value;
  }

  set(value: number, notify: boolean): void {
    const next = clamp(value, this.min, this.max);
    const changed = next !== this.value;
    this.value = next;
    this.render();
    if (notify && changed) {
      this.onInput(this.value);
    }
  }

  /** How much one step of the arrow keys moves the knob. */
  private step(): number {
    return (this.max - this.min) / 100;
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
    const ratio = range === 0 ? 0 : (this.value - this.min) / range;
    this.dial.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
    this.dial.setAttribute('aria-valuenow', String(Math.round(this.value)));
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
  private readonly legendRows: HTMLElement[] = [];
  private readonly legendNames: HTMLElement[][] = [[], []];
  private rhythmSection!: HTMLElement;
  private readonly faders: Fader[] = [];
  /** The tempo knob of the panel. */
  private tempoKnob!: Knob;
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

  /** The knobs of the band, and the positions they come up in. */
  private readonly bandControls: MiniKnob[] = [];
  /** The names of the knobs of the band, in the order of the row. */
  private readonly bandIds: string[] = [];
  /** The positions the knobs of the band come up in, by name. */
  private readonly bandDefaults: Record<string, number> = {};
  /**
   * The settings the knobs of the band stand at.
   *
   * They are the settings of the memory position that is selected: the
   * factory rhythms are played with the settings the machine comes up
   * with, and the user patterns with the ones of that position. They are
   * kept by the name of the knob, so a knob that changes its function does
   * not take the position of the knob that stood there before.
   */
  private get bandValues(): Record<string, number> {
    return this.bandMemories[this.bandMemory] ?? {};
  }

  /**
   * The memory positions of the knobs of the band.
   *
   * Every position keeps the settings of the knobs, by the name of the
   * knob. The position that is selected is the one the knobs stand at: a
   * knob that is turned writes into it, and the position that is picked
   * brings its own settings to the knobs.
   */
  private readonly bandMemories: Record<string, number>[] = [];

  /** The memory position of the knobs that is selected. */
  private bandMemory = 0;

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

  // The keys that are being held down. A pointer press belongs to the
  // pointer that made it, so a second finger can hold a second key; the
  // keyboard has a press of its own. The keyboard click must not be
  // carried out twice.
  private readonly pointerPresses = new Map<number, KeyPress>();
  private keyPress: KeyPress | null = null;
  private keyboardHandled = false;
  private readonly shortcutKeys = new Map<string, number>();

  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlash = -1;
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );

  constructor(engine: PoppyEngine, host: HTMLElement) {
    this.engine = engine;
    this.savedControls = loadControlPositions();

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
      onMeter: (meter) => {
        void this.writeMeter(meter);
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

    // The user patterns of the last visit are put back into the engine
    // before the card reads anything.
    for (const [index, pattern] of loadUserPatterns()) {
      this.userPatterns.set(index, pattern);
      this.engine.setUserPattern(index, pattern);
    }

    engine.onPanel((state) => this.render(state));
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
   * selected position back. The first seven knobs reach into the engine
   * and move the parameters it holds fixed today; the one after them
   * spreads the instruments over the stereo field. The user patterns are
   * written on the pattern card, not on this strip.
   */
  private buildExtendedSection(): HTMLElement {
    const section = element('div', 'extended-section');
    const strip = element('div', 'write-strip');
    const knobs = bandKnobs(this.engine);

    for (let index = knobs.length; index < PANEL_KNOBS; index += 1) {
      knobs.push({
        id: `spare-${index + 1}`,
        label: String(index + 1),
        ariaLabel: `Knob ${index + 1}, no function yet`,
        min: 0,
        max: 1,
        value: 0.5,
        valueText: (value) => `${Math.round(value * 100)} percent`,
        showReadout: false,
        onInput: () => {
          // The knob has no function of its own yet.
        },
      });
    }

    knobs.forEach((knob) => {
      const control = new MiniKnob({
        label: knob.label,
        min: knob.min,
        max: knob.max,
        value: knob.value,
        ariaLabel: knob.ariaLabel,
        valueText: knob.valueText,
        showReadout: knob.showReadout ?? true,
        onInput: (value) => {
          knob.onInput(value);
          // The panel moves the knobs itself when the source changes: that
          // is not the user giving a new setting.
          if (!this.restoring) {
            this.bandValues[knob.id] = value;
            this.keepControlPositions();
          }
        },
      });
      this.bandControls.push(control);
      this.bandIds.push(knob.id);
      this.bandDefaults[knob.id] = knob.value;
      strip.append(control.element);
    });

    // The memory positions of the knobs. Every position keeps the
    // settings of the knobs by the name of the knob, so a knob that
    // changes its function does not take the settings of the knob that
    // stood there before. A position that was not there at the last visit
    // comes up with the settings the machine comes up with.
    const storedMemories = this.savedControls.memories ?? [];
    const storedMemory = this.savedControls.memory ?? 0;
    this.bandMemory =
      storedMemory >= 0 && storedMemory < BAND_MEMORY_COUNT ? storedMemory : 0;
    for (let index = 0; index < BAND_MEMORY_COUNT; index += 1) {
      const position: Record<string, number> = {};
      const stored = storedMemories[index] ?? {};
      for (const id of this.bandIds) {
        const fallback = this.bandDefaults[id];
        if (fallback !== undefined) {
          position[id] = stored[id] ?? fallback;
        }
      }
      this.bandMemories.push(position);
    }
    // A machine that was left before the memory positions existed keeps
    // the settings it had: they belong to the position that is selected.
    if (storedMemories.length === 0) {
      const stored = this.savedControls.band ?? {};
      for (const id of this.bandIds) {
        const value = stored[id];
        if (value !== undefined) {
          this.bandValues[id] = value;
        }
      }
    }

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
    // where they come up in.
    const reset = element('button', 'write-strip-reset');
    reset.type = 'button';
    reset.title = 'Put the knobs of the selected memory position back';
    reset.setAttribute('aria-label', reset.title);
    reset.append(resetIcon('write-strip-reset-icon'));
    reset.addEventListener('click', () => {
      this.resetKnobs();
    });
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
   * The knobs of the band follow the source.
   *
   * The factory rhythms are played with the settings the machine comes up
   * with, and the user patterns with the settings of the memory position
   * that is selected. The positions the user chose are kept either way:
   * the mode lever does not throw them away.
   */
  private applyBandValues(values: Record<string, number>): void {
    this.restoring = true;
    try {
      this.bandIds.forEach((id, index) => {
        const value = values[id];
        if (value !== undefined) {
          this.bandControls[index]?.set(value, true);
        }
      });
    } finally {
      this.restoring = false;
    }
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
    // comes up with.
    if (this.displayedSource() === PATTERN_SOURCE_USER) {
      this.applyBandValues(this.bandValues);
    }
    this.keepControlPositions();
    this.showStatus(`The knobs of memory ${index + 1} are in place`, false);
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
      band: { ...this.bandValues },
      memories: this.bandMemories.map((memory) => ({ ...memory })),
      memory: this.bandMemory,
    });
  }

  /**
   * Put the knobs of the selected memory position back where they belong.
   *
   * The square button at the end of the band does it: it is the only way
   * back to the positions the machine comes up in. Only the position that
   * is selected is put back; the other ones keep the settings they were
   * given.
   */
  private resetKnobs(): boolean {
    const values = this.bandValues;
    this.bandIds.forEach((id, index) => {
      const fallback = this.bandDefaults[id];
      if (fallback !== undefined) {
        values[id] = fallback;
        this.bandControls[index]?.set(fallback, true);
      }
    });
    this.keepControlPositions();
    this.showStatus(
      `The knobs of memory ${this.bandMemory + 1} are back where they belong`,
      false,
    );
    return true;
  }

  private buildTopControls(): HTMLElement {
    const top = element('div', 'top-controls');

    const brand = element('div', 'brand');
    const plate = element('div', 'brand-plate');
    plate.append(
      element('span', 'brand-name', 'libpoppy'),
      element('span', 'brand-sub', 'rhythm demo'),
    );
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

    const right = element('div', 'right-controls');
    const lampBlock = element('div', 'lamp-block');
    const markA = element('span', 'lamp-mark lamp-mark-a');
    markA.setAttribute('aria-hidden', 'true');
    const markB = element('span', 'lamp-mark lamp-mark-b');
    markB.setAttribute('aria-hidden', 'true');
    lampBlock.append(
      element('span', 'lamp lamp-a'),
      element('span', 'lamp lamp-b'),
      markA,
      markB,
    );

    // The mode lever sits above the bank lever, in the same column: it
    // picks the factory rhythms or the user patterns.
    this.modeSwitch = element('button', 'mode-switch');
    this.modeSwitch.type = 'button';
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

    this.bankSwitch = element('button', 'bank-switch');
    this.bankSwitch.type = 'button';
    this.bankSwitch.setAttribute('role', 'switch');
    this.bankSwitch.setAttribute('aria-checked', 'false');
    this.bankSwitch.setAttribute('aria-label', 'Rhythm bank A or B');
    const bankSlot = element('span', 'lever-slot');
    bankSlot.append(element('span', 'lever-arm'));
    this.bankSwitch.append(bankSlot);
    lampBlock.append(this.bankSwitch);

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
    keys.title =
      'Click a rhythm to select it on its own, click a lit rhythm to keep the selection, hold it down to add it to the selection, press two keys at the same time to latch them together. On the keyboard: 1 to 0 press the ten rhythm keys, A and B pick the bank, Space starts and stops.';
    for (let index = 0; index < 10; index += 1) {
      const button = element('button', 'rhythm-key');
      button.type = 'button';
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
      button.addEventListener('keydown', (event) =>
        this.onKeyKeyDown(index, event),
      );
      button.addEventListener('keyup', (event) => this.onKeyKeyUp(index, event));
      button.addEventListener('blur', () => this.cancelKeyPress());
      button.addEventListener('click', (event) => this.onKeyClick(index, event));
      // A long press on a touch screen must not open the context menu.
      button.addEventListener('contextmenu', (event) => event.preventDefault());
      this.keyButtons.push(button);
      keys.append(button);
    }

    // The start/stop switch is momentary: it is pressed down while the
    // finger is on it and springs back afterwards. The pilot lamp above
    // the legends tells whether the machine runs, `aria-pressed` tells it
    // to a screen reader.
    this.startStop = element('button', 'start-stop');
    this.startStop.type = 'button';
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

    section.append(legend, keybed);
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
    // The extended mode is left behind: a pattern that was written but
    // not saved goes back to the contents the browser holds.
    if (source === PATTERN_SOURCE_PRESET) {
      this.discardUnsavedPatterns();
      // The factory rhythms are played with the settings the machine comes
      // up with.
      this.applyBandValues(this.bandDefaults);
    } else {
      // The user patterns are played with the settings of the memory
      // position that is selected.
      this.applyBandValues(this.bandValues);
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
    if (this.transportIntent) {
      this.transportIntent = false;
      this.engine.stop();
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

  private selectBank(bank: Bank): void {
    if (this.displayedBank() === bank) {
      return;
    }
    this.requestSelection(bank, this.displayedButtons());
  }

  private onShortcutKeyDown(event: KeyboardEvent): void {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      this.isTypingTarget(event) ||
      this.isCardTarget(event)
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

  /**
   * Whether the key belongs to the pattern card.
   *
   * The card is a switchboard of its own: the arrow keys walk over the
   * grid and the space bar puts a voice into a step. The shortcuts of the
   * panel wait until the user is back on the panel.
   */
  private isCardTarget(event: KeyboardEvent): boolean {
    const target = event.target;
    return target instanceof Node && this.card.element.contains(target);
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
   * the only latched one. A key that is already latched is left alone,
   * and so is every other key: a click on a lit key must not switch the
   * machine off.
   */
  private applyShortPress(index: number): void {
    const buttons = this.displayedButtons();
    const bit = 1 << index;
    if ((buttons & bit) !== 0) {
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

  private beginKeyPress(index: number): void {
    this.endKeyPress();
    const press: KeyPress = {
      index,
      long: false,
      timer: 0,
      chord: false,
      footprint: null,
    };
    press.timer = setTimeout(() => {
      if (this.keyPress !== press) {
        return;
      }
      press.long = true;
      this.applyLongPress(index);
    }, LONG_PRESS_MS);
    this.keyPress = press;
  }

  private endKeyPress(): void {
    if (this.keyPress === null) {
      return;
    }
    clearTimeout(this.keyPress.timer);
    this.keyPress = null;
  }

  /**
   * A key that loses the focus while it is held down gives the press back.
   * Only a key press is taken back this way: a pointer press belongs to
   * the key that is under the pointer, and the focus moves to that key
   * while the press is already running.
   */
  private cancelKeyPress(): void {
    this.endKeyPress();
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
    this.keyboardHandled = false;
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

  private onKeyKeyDown(index: number, event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    if (event.repeat) {
      return;
    }
    this.keyboardHandled = false;
    this.beginKeyPress(index);
  }

  private onKeyKeyUp(index: number, event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    const press = this.keyPress;
    if (press === null || press.index !== index) {
      return;
    }
    this.endKeyPress();
    this.keyboardHandled = true;
    if (!press.long) {
      this.applyShortPress(index);
    }
  }

  /**
   * The click that follows a press. A click that comes from the mouse or
   * from a touch screen was already handled by the pointer events; a click
   * that the keyboard produced is handled here.
   */
  private onKeyClick(index: number, event: MouseEvent): void {
    if (event.detail !== 0) {
      return;
    }
    if (this.keyboardHandled) {
      this.keyboardHandled = false;
      return;
    }
    if (this.keyPress !== null) {
      // Enter produces its click while the key is still held down.
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
    }

    // The card shows the pattern that plays, so it has to read it again.
    this.card.invalidate();
    // The pattern is not in the browser until the save button is pressed.
    this.markUnsaved();
  }

  /**
   * Write the meter of the card into the user patterns of the selection.
   *
   * The meter says how many of the steps of a bar the machine plays, and
   * the steps outside the bar are skipped. It belongs to the whole
   * selection, the way a step of the card does: the mask is written into
   * every user pattern that is latched.
   */
  private async writeMeter(label: string): Promise<void> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return;
    }

    const meter = meterByLabel(label);
    if (meter === null) {
      return;
    }

    const slots = this.selectionSlots();
    if (slots.length === 0) {
      this.showStatus('Select a pattern before you set its meter', true);
      return;
    }

    const mask = meterMask(meter);
    const enableLo = Number(mask & 0xffffffffn) >>> 0;
    const enableHi = Number((mask >> 32n) & 0xffffffffn) >>> 0;

    for (const slot of slots) {
      const pattern = await this.userPattern(slot);
      if (pattern === null) {
        return;
      }
      const next: UserPattern = { ...pattern, enableLo, enableHi };
      this.userPatterns.set(slot, next);
      this.engine.setUserPattern(slot, next);
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
   * Copy the pattern of the selection to the clipboard.
   *
   * The clipboard is a temporary one and it holds the notes of the
   * pattern: the hits and the accents. A pattern that is copied and
   * pasted comes back the way it was.
   */
  private async copyPattern(): Promise<boolean> {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
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
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
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
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
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
   * not in the browser yet.
   */
  private savePatterns(): boolean {
    if (this.displayedSource() !== PATTERN_SOURCE_USER) {
      return false;
    }
    saveUserPatterns(this.userPatterns);
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
   * empty pattern the engine starts with.
   */
  private discardUnsavedPatterns(): void {
    if (!this.patternsUnsaved) {
      return;
    }
    this.patternsUnsaved = false;

    const saved = loadUserPatterns();
    for (const slot of [...this.userPatterns.keys()]) {
      const restored = saved.get(slot) ?? emptyUserPattern();
      this.userPatterns.set(slot, restored);
      this.engine.setUserPattern(slot, restored);
    }

    // The card shows the patterns that play, so it has to read them again.
    this.card.setUnsaved(false);
    this.card.invalidate();
    this.showStatus('The changes that were not saved are gone', false);
  }

  /**
   * The black cover and the mode lever follow the source: in the extended
   * mode the cover slides up and the write strip is there.
   */
  private renderSource(): void {
    const extended = this.displayedSource() === PATTERN_SOURCE_USER;
    this.cabinet.classList.toggle('is-extended', extended);
    this.modeSwitch.setAttribute(
      'aria-checked',
      extended ? 'true' : 'false',
    );
    if (extended) {
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
    } else if (this.reducedMotion.matches) {
      this.clearFlash();
      this.setLamps(state.bank);
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

    if (this.reducedMotion.matches) {
      this.legendFading = false;
      for (const name of names) {
        name.classList.remove('is-fading');
      }
      this.writeLegendNames();
      return;
    }

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
