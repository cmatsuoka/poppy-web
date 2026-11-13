/*
 * band-code.ts - the way into the band of knobs from the classic mode.
 *
 * The band of knobs under the black cover belongs to the advanced mode:
 * the mode lever throws the source and the cover slides back with it.
 * There is a second way in, and it is not printed on the machine.
 *
 * The way in is a sequence of steps: the arrows of the keyboard, and the
 * A/B selector at the end. The selector is a lever with two positions, so
 * the two last steps are the lever going to B and the lever coming back
 * to A:
 *
 *   up, up, down, down, left, right, left, right, B, A
 *
 * The steps have to follow each other in quick succession: a step that
 * comes too late after the one before it starts the sequence over.
 */

/** The steps of the sequence, in the order they are typed. */
export const BAND_CODE = [
  'up',
  'up',
  'down',
  'down',
  'left',
  'right',
  'left',
  'right',
  'selector-b',
  'selector-a',
] as const;

/** One step of the sequence. */
export type BandCodeStep = (typeof BAND_CODE)[number];

/**
 * How long a step may come after the one before it.
 *
 * The steps are typed in quick succession: a pause in the middle of the
 * sequence starts it over.
 */
export const BAND_CODE_TIMEOUT_MS = 2500;

/**
 * The name of an arrow key, in the words of the sequence.
 *
 * A key of the keyboard that is not an arrow is not a step.
 */
function stepForKey(key: string): BandCodeStep | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/**
 * The name of a position of the A/B selector, in the words of the sequence.
 *
 * The selector is a lever with two positions, so a step is the lever
 * moving to a position, not a press of a button.
 */
function stepForSelector(bank: 0 | 1): BandCodeStep {
  return bank === 1 ? 'selector-b' : 'selector-a';
}

/** One step of the sequence, and when it came. */
interface CodeStep {
  step: BandCodeStep;
  at: number;
}

/**
 * The sequence, and the machine that watches for it.
 *
 * The machine is told every step: the arrows of the keyboard and the
 * position the A/B selector is moved to. When the whole sequence has been
 * typed, the machine says so and starts over, so it can be typed again.
 *
 * The steps are kept in a window that slides: the sequence is the last
 * steps that came, in the order they came. A pause in the middle starts
 * the sequence over, so the steps have to follow each other in quick
 * succession.
 */
export class BandCode {
  /** The steps that came. */
  private readonly steps: CodeStep[] = [];

  constructor(private readonly onComplete: () => void) {}

  /**
   * An arrow of the keyboard was pressed.
   *
   * The key is only a step of the sequence when it is an arrow: any other
   * key says nothing about it.
   */
  noteArrow(key: string, now: number = Date.now()): boolean {
    const step = stepForKey(key);
    if (step === null) {
      return false;
    }
    this.note(step, now);
    return true;
  }

  /**
   * The A/B selector was moved.
   *
   * Only a move of the selector is a step: the selector standing where it
   * stands says nothing.
   */
  noteSelector(bank: 0 | 1, now: number = Date.now()): boolean {
    return this.note(stepForSelector(bank), now);
  }

  /** Forget the steps that came before: the sequence starts over. */
  reset(): void {
    this.steps.length = 0;
  }

  /**
   * Take a step of the sequence.
   *
   * A step that comes too long after the step before it starts the
   * sequence over. The steps that came are kept in a window that slides,
   * so the sequence may start at any of them. The machine says whether
   * the step was a step of the sequence.
   */
  private note(step: BandCodeStep, now: number): boolean {
    const last = this.steps[this.steps.length - 1];
    if (last !== undefined && now - last.at > BAND_CODE_TIMEOUT_MS) {
      this.steps.length = 0;
    }

    this.steps.push({ step, at: now });
    while (this.steps.length > BAND_CODE.length) {
      this.steps.shift();
    }

    const steps = this.steps.map((entry) => entry.step);
    if (!BAND_CODE.every((want, index) => want === steps[index])) {
      return false;
    }

    this.steps.length = 0;
    this.onComplete();
    return true;
  }
}
