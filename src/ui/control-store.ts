/*
 * control-store.ts - the positions of the controls between two visits.
 *
 * The five faders, the tempo knob and the knobs of the band are the
 * settings of the machine: where they stand is how the user left them.
 * They are kept in the browser, so the machine comes up the way it was
 * left, and the reset button of the pattern editor puts the knobs of the
 * band back where they belong.
 *
 * The knobs of the band live in four memory positions: the position that
 * is selected is the one the knobs stand at, and it is the one the reset
 * button puts back. The positions and the selected one are kept in the
 * browser as well.
 *
 * A control that is turned gives a lot of changes in a short time, and
 * every one of them would be a write to the browser. The write waits
 * until the last change is a moment old, so that a knob that is turned
 * is written once and not on every step of the turn.
 */

const STORAGE_KEY = 'poppy-web.controls.v1';

/** How long the controls have to stand still before they are written. */
const WRITE_DELAY = 500;

export interface ControlPositions {
  /** The tempo, in beats per minute. */
  tempo?: number;
  /** The position of the five faders, in the order of the panel. */
  faders?: number[];
  /**
   * The position of the knobs of the band, by the name of the knob.
   *
   * The knobs are told apart by their name and not by their place in the
   * row, so a knob that changes its function does not come up with the
   * position of the knob that stood there before.
   */
  band?: Record<string, number>;
  /**
   * The memory positions of the band of knobs.
   *
   * Every position keeps the settings of the knobs the way `band` does,
   * by the name of the knob. A position that was not there at the last
   * visit comes up with the settings the machine comes up with.
   */
  memories?: Record<string, number>[];
  /** The memory position of the band that is selected. */
  memory?: number;
}

function isNumbers(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (entry) => typeof entry === 'number' && Number.isFinite(entry),
  );
}

function isNumberRecordArray(
  value: unknown,
): value is Record<string, number>[] {
  return Array.isArray(value) && value.every((entry) => isNumberRecord(entry));
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
  if (isNumberRecord(record.band)) {
    positions.band = record.band;
  }
  if (isNumberRecordArray(record.memories)) {
    positions.memories = record.memories;
  }
  if (
    typeof record.memory === 'number' &&
    Number.isInteger(record.memory) &&
    record.memory >= 0
  ) {
    positions.memory = record.memory;
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
