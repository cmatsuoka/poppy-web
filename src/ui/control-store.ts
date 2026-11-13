/*
 * control-store.ts - the positions of the controls between two visits.
 *
 * The five faders, the tempo knob and the knobs of the band are the
 * settings of the machine: where they stand is how the user left them.
 * They are kept in the browser, so the machine comes up the way it was
 * left, and the reset button of the band puts the knobs of the selected
 * memory position back to their default values.
 *
 * The knobs of the band live in four memory positions: the position that
 * is selected is the one the knobs stand at, and it is the one the reset
 * button puts back. Every position keeps the accent gain and the settings
 * of every instrument the selector of the band can pick. The positions,
 * the selected one and the instrument the selector stands at are kept in
 * the browser as well.
 *
 * A control that is turned gives a lot of changes in a short time, and
 * every one of them would be a write to the browser. The write waits
 * until the last change is a moment old, so that a knob that is turned
 * is written once and not on every step of the turn.
 */

const STORAGE_KEY = 'poppy-web.controls.v2';

/**
 * The version of the memory positions of the band of knobs.
 *
 * The positions are read back only when they carry this version: the
 * ranges of the knobs and the values the positions are given changed
 * with it, and the positions of an older machine mean something else.
 * The tempo and the faders do not depend on it, and they are kept.
 *
 * Version 4 is the band with the selector: a position carries the accent
 * gain and the settings of every instrument the selector can pick, where
 * the band before carried one value per knob.
 */
export const MEMORIES_VERSION = 4;

/** How long the controls have to stand still before they are written. */
const WRITE_DELAY = 500;

/**
 * The settings of one instrument of the band, as the browser keeps them.
 *
 * The keys are the parameters the six knobs of the band carry: the level,
 * the place in the stereo field, the cut-off, the decay and the reverb
 * send. The tone is not among them: it has nothing in the engine to reach
 * for yet.
 */
export interface StoredInstrumentSettings {
  vol?: number;
  pan?: number;
  tone?: number;
  filter?: number;
  decay?: number;
  send?: number;
}

/**
 * One memory position of the band of knobs, as the browser keeps it.
 *
 * The accent gain and the settings of the twelve instruments the selector
 * can pick, in the order of the selector.
 */
export interface StoredBandMemory {
  accent?: number;
  instruments?: StoredInstrumentSettings[];
}

export interface ControlPositions {
  /** The tempo, in beats per minute. */
  tempo?: number;
  /** The position of the five faders, in the order of the panel. */
  faders?: number[];
  /**
   * Whether the band of knobs has been opened in the classic mode.
   *
   * The hidden sequence opens the band, and the band stays open: the
   * machine comes up the way the user left it.
   */
  bandUnlocked?: boolean;
  /**
   * The version of the memory positions of the band of knobs.
   *
   * The positions are read back only when they carry the version the
   * panel writes today.
   */
  memoriesVersion?: number;
  /** The memory positions of the band of knobs. */
  memories?: StoredBandMemory[];
  /** The memory position of the band that is selected. */
  memory?: number;
  /**
   * The instrument the selector of the band stands at, as the engine
   * voice it picks.
   */
  instrument?: number;
}

function isNumbers(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function isStoredInstrument(value: unknown): value is StoredInstrumentSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
}

function isStoredBandMemory(value: unknown): value is StoredBandMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.accent !== undefined &&
    (typeof record.accent !== 'number' || !Number.isFinite(record.accent))
  ) {
    return false;
  }
  if (record.instruments !== undefined) {
    if (!Array.isArray(record.instruments)) {
      return false;
    }
    return record.instruments.every((entry) => isStoredInstrument(entry));
  }
  return true;
}

/**
 * The positions of the last visit, if there are any.
 *
 * A browser that does not let the page store anything is not an error: the
 * controls simply start where they belong.
 */
export function loadControlPositions(): ControlPositions {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const positions: ControlPositions = {};
  if (typeof record.tempo === 'number' && Number.isFinite(record.tempo)) {
    positions.tempo = record.tempo;
  }
  if (isNumbers(record.faders)) {
    positions.faders = record.faders;
  }
  if (record.bandUnlocked === true) {
    positions.bandUnlocked = true;
  }
  // The memory positions are read back only when they carry the version
  // the panel writes today: the positions of an older machine mean
  // something else, and the ranges of the knobs have changed with them.
  if (
    record.memoriesVersion === MEMORIES_VERSION &&
    Array.isArray(record.memories) &&
    record.memories.every((entry) => isStoredBandMemory(entry))
  ) {
    positions.memoriesVersion = MEMORIES_VERSION;
    positions.memories = record.memories;
  }
  if (
    typeof record.memory === 'number' &&
    Number.isInteger(record.memory) &&
    record.memory >= 0
  ) {
    positions.memory = record.memory;
  }
  if (
    typeof record.instrument === 'number' &&
    Number.isInteger(record.instrument) &&
    record.instrument >= 0
  ) {
    positions.instrument = record.instrument;
  }
  return positions;
}

/** Keep the positions of the controls for the next visit. */
export function saveControlPositions(positions: ControlPositions): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // A browser that does not let the page store anything simply does not
    // keep the positions.
  }
}

/**
 * The writer of the positions of the controls.
 *
 * The write waits until the controls have come to rest: the last change in
 * a row is the one that counts, and the positions that were written
 * before it are not written again.
 */
export class ControlWriter {
  private timer: number | null = null;
  private positions: ControlPositions = {};

  /** Take the positions of the controls and write them when they settle. */
  update(positions: ControlPositions): void {
    this.positions = { ...this.positions, ...positions };
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      saveControlPositions(this.positions);
    }, WRITE_DELAY);
  }

  /** Write the positions at once, if a write is waiting for it. */
  flush(): void {
    if (this.timer === null) {
      return;
    }
    window.clearTimeout(this.timer);
    this.timer = null;
    saveControlPositions(this.positions);
  }
}
