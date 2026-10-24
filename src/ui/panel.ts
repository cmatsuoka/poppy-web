import type { PoppyEngine } from '../audio/engine';
import {
  RHYTHM_NAMES,
  type Bank,
  type PanelState,
} from '../audio/protocol';

const Q16 = 65536;

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

interface FaderOptions {
  label: string;
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
    this.element.setAttribute('aria-label', `${options.label} volume`);
    this.element.setAttribute('aria-valuemin', '0');
    this.element.setAttribute('aria-valuemax', '100');

    const scale = element('div', 'fader-scale');
    scale.setAttribute('aria-hidden', 'true');

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
    this.element.append(this.travel, scale, name);

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
    caption.append(
      element('span', 'tempo-edge', 'SLOW'),
      element('span', 'tempo-name', 'TEMPO'),
      element('span', 'tempo-edge', 'FAST'),
    );

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
      const delta = (dragStartY - event.clientY) * 0.85;
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

  private render(): void {
    const ratio = (this.value - this.min) / (this.max - this.min);
    this.base.style.setProperty('--angle', `${-135 + ratio * 270}deg`);
    this.dial.setAttribute('aria-valuenow', String(this.value));
    this.dial.setAttribute('aria-valuetext', `${this.value} beats per minute`);
    this.readout.value = `${this.value} BPM`;
    this.readout.textContent = `${this.value} BPM`;
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
  private readonly lamps: [HTMLElement, HTMLElement];
  private bankSwitch!: HTMLButtonElement;
  private startStop!: HTMLButtonElement;
  private readonly status: HTMLParagraphElement;

  private state: PanelState = {
    bank: 0,
    buttons: 0,
    pendingBank: 0,
    pendingButtons: 0,
    pending: false,
    running: false,
    column: 0,
    flashCount: 0,
  };

  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlash = -1;
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );

  constructor(engine: PoppyEngine, host: HTMLElement) {
    this.engine = engine;

    this.root = element('div', 'stage');
    const unit = element('div', 'unit');
    const cabinet = element('div', 'cabinet');
    const deck = element('div', 'deck');
    deck.setAttribute('aria-hidden', 'true');
    const faceplate = element('div', 'faceplate');
    faceplate.append(this.buildTopControls(), this.buildRhythmControls());
    cabinet.append(deck, faceplate);
    unit.append(cabinet);
    this.root.append(unit);

    this.status = element('p', 'status');
    this.status.setAttribute('role', 'status');
    this.root.append(this.status);

    host.append(this.root);

    for (const fader of this.faders) {
      fader.observe();
    }

    this.lamps = [
      this.root.querySelector<HTMLElement>('.lamp-a')!,
      this.root.querySelector<HTMLElement>('.lamp-b')!,
    ];
    this.bankSwitch = this.root.querySelector<HTMLButtonElement>('.bank-switch')!;
    this.startStop = this.root.querySelector<HTMLButtonElement>('.start-stop')!;

    this.wireEvents();
    engine.onPanel((state) => this.render(state));
    engine.onError((message) => this.showStatus(message, true));
    this.showStatus('Press START to play', false);
  }

  private buildTopControls(): HTMLElement {
    const top = element('div', 'top-controls');

    const brand = element('div', 'brand');
    const plate = element('div', 'brand-plate');
    plate.append(
      element('span', 'brand-name', 'poppy'),
      element('span', 'brand-sub', 'rhythm unit'),
    );
    brand.append(plate);

    const faderBank = element('div', 'fader-bank');
    const faderDefs: Array<{
      label: string;
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
      { label: 'Volume', color: 'yellow', value: 50, target: 'volume', scale: 'left' },
      {
        label: 'Balance',
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
      onInput: (value) => this.engine.setTempo(value),
    });

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

    this.bankSwitch = element('button', 'bank-switch');
    this.bankSwitch.type = 'button';
    this.bankSwitch.setAttribute('role', 'switch');
    this.bankSwitch.setAttribute('aria-checked', 'false');
    this.bankSwitch.setAttribute('aria-label', 'Rhythm bank A or B');
    const bankSlot = element('span', 'bank-slot');
    bankSlot.append(element('span', 'bank-arm'));
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
    keys.title = 'Click rhythms to latch them; several can play together.';
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
      button.addEventListener('click', () => this.toggleRhythm(index));
      this.keyButtons.push(button);
      keys.append(button);
    }

    this.startStop = element('button', 'start-stop');
    this.startStop.type = 'button';
    this.startStop.setAttribute('aria-pressed', 'false');
    this.startStop.setAttribute('aria-label', 'Start or stop rhythm');
    const startLabel = element('span', 'start-label');
    const runLed = element('span', 'run-led');
    runLed.setAttribute('aria-hidden', 'true');
    startLabel.append(runLed, document.createTextNode('START'));
    const rocker = element('span', 'start-rocker');
    const stopLabel = element('span', 'stop-label', 'STOP');
    this.startStop.append(startLabel, rocker, stopLabel);
    keys.append(this.startStop);

    const keybed = element('div', 'keybed');
    keybed.append(keys);

    section.append(legend, keybed);
    return section;
  }

  private wireEvents(): void {
    this.bankSwitch.addEventListener('click', () => {
      const bank: Bank = this.displayedBank() === 0 ? 1 : 0;
      this.engine.select(bank, this.displayedButtons());
    });

    this.startStop.addEventListener('click', () => {
      if (this.state.running) {
        this.engine.stop();
        return;
      }
      this.startStop.disabled = true;
      this.engine
        .start()
        .catch((error: unknown) => {
          this.showStatus(
            error instanceof Error ? error.message : String(error),
            true,
          );
        })
        .finally(() => {
          this.startStop.disabled = false;
        });
    });
  }

  private toggleRhythm(index: number): void {
    const mask = this.displayedButtons() ^ (1 << index);
    this.engine.select(this.displayedBank(), mask);
  }

  private displayedBank(): Bank {
    return this.state.pending ? this.state.pendingBank : this.state.bank;
  }

  private displayedButtons(): number {
    return this.state.pending ? this.state.pendingButtons : this.state.buttons;
  }

  private render(state: PanelState): void {
    const wasRunning = this.state.running;
    this.state = state;

    const bank = this.displayedBank();
    const buttons = this.displayedButtons();

    this.rhythmSection.dataset.bank = String(bank);

    this.keyButtons.forEach((button, index) => {
      const latched = (buttons & (1 << index)) !== 0;
      button.setAttribute('aria-pressed', latched ? 'true' : 'false');
    });

    this.legendNames.forEach((row, rowIndex) => {
      row.forEach((name, index) => {
        const latched = rowIndex === bank && (buttons & (1 << index)) !== 0;
        name.classList.toggle('is-selected', latched);
      });
    });

    this.legendRows[0]?.classList.toggle('active', bank === 0);
    this.legendRows[1]?.classList.toggle('active', bank === 1);
    this.bankSwitch.setAttribute('aria-checked', bank === 1 ? 'true' : 'false');
    this.startStop.setAttribute('aria-pressed', state.running ? 'true' : 'false');

    if (!state.running) {
      this.clearFlash();
      this.setLamps(state.bank);
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
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }
}
