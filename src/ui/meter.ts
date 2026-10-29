/*
 * meter.ts - the meters the pattern editor offers.
 *
 * A pattern names its time signature, and the machine plays the steps of
 * that meter: the steps that lie outside the bar are skipped, and a
 * skipped step takes no time at all, so the bar of the meter is shorter
 * than the bar of the card.
 *
 * The signature is also the grid the pattern plays on. The 4/4, the 3/4,
 * the 5/4 and the 7/4 play on the straight grid, where a beat holds eight
 * columns of the cycle. The 2/4 and the 6/8 share the compound grid,
 * where a beat holds six columns: it is the only grid that can carry a
 * 2:1 swung eighth, and the three factory rhythms that play on it are the
 * shuffle rhythms of the machine.
 *
 * The mask of the steps a meter plays is the engine's own: it is derived
 * from the signature, and the panel reads it back from the engine instead
 * of keeping a copy of it.
 */

import { TIMESIG, type TimeSignature } from '../audio/protocol';

/** A meter the pattern editor offers. */
export interface Meter {
  /** The name of the meter, as the card prints it. */
  readonly label: string;
  /** The time signature of the meter, the engine's own number. */
  readonly timesig: TimeSignature;
  /** What the meter does to the grid, for the tooltip of the control. */
  readonly title: string;
}

/**
 * The meters of the editor, in the order the control lists them.
 *
 * The default is 4/4: every step of the card is played, which is the
 * pattern the engine comes up with.
 */
export const METERS: readonly Meter[] = [
  {
    label: '2/4',
    timesig: TIMESIG['2/4'],
    title:
      'Two beats to the bar: the pattern plays on the compound grid, where a beat holds six columns and two of every eight columns are skipped',
  },
  {
    label: '3/4',
    timesig: TIMESIG['3/4'],
    title:
      'Three beats to the bar: the machine plays six beats of the cycle and skips the four stretches of four columns that lie between them',
  },
  {
    label: '4/4',
    timesig: TIMESIG['4/4'],
    title: 'Four beats to the bar: every step of the card is played',
  },
  {
    label: '5/4',
    timesig: TIMESIG['5/4'],
    title:
      'Five beats to the bar: the rhythm plays the row of the meter, whose runs of six and of four columns are the cells of the groove',
  },
  {
    label: '6/8',
    timesig: TIMESIG['6/8'],
    title:
      'The shuffle grid of the machine: a beat holds six columns, and the pattern is a 4/4 groove played with triplets',
  },
  {
    label: '7/4',
    timesig: TIMESIG['7/4'],
    title:
      'Seven beats to the bar: the bar is the first fifty-six columns of the cycle, and the columns that follow it are skipped',
  },
];

/** The meter of a pattern that skips no step at all. */
export const DEFAULT_METER = '4/4';

/**
 * The name of the meter of a selection that carries more than one.
 *
 * The meter belongs to the whole selection, the way a step of the card
 * does: a meter that is picked is written into every pattern that is
 * latched. A selection of patterns with different meters is only possible
 * when they came from a file, and the control says so.
 */
export const MIXED_METER = 'mixed';

/** The meter of a time signature. */
export function meterOfTimesig(timesig: number): Meter | null {
  return METERS.find((meter) => meter.timesig === timesig) ?? null;
}
