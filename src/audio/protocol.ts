export type Bank = 0 | 1;

/**
 * Which set of patterns the sequencer plays: the 20 factory rhythms or the
 * 20 user-defined slots. The panel's mode lever switches between them.
 */
export type PatternSource = 0 | 1;

export const PATTERN_SOURCE_PRESET: PatternSource = 0;
export const PATTERN_SOURCE_USER: PatternSource = 1;

export const INSTRUMENT_NAMES = [
  'Bass',
  'Snare 1',
  'Snare 2',
  'Small Bongo',
  'Large Bongo',
  'Conga',
  'Cowbell',
  'Claves',
  'Hi-Hat',
  'Rimshot',
  'Cymbal 1',
  'Cymbal 2',
  'Tambourine',
  'Guiro',
  'Quijada',
] as const;

/**
 * The names of the factory rhythms.
 *
 * They are written here as they are read. The machine prints its names in
 * capitals, and the print does it with the type of the panel: the key bed
 * and the card set their names in capitals.
 */
export const RHYTHM_NAMES = [
  'Waltz',
  'Samba',
  'Mambo',
  'Rumba',
  'Tango',
  'Bossa Nova',
  'Rock 1',
  'Rock 3',
  'March 2/4',
  'Swing',
  'Jazz Waltz',
  'Meringue',
  'Cha-Cha',
  'Beguine',
  'Habanera',
  'Slow Rock',
  'Rock 2',
  'Rock 4',
  'March 6/8',
  'Latin Swing',
] as const;

export const INSTRUMENT_COUNT = INSTRUMENT_NAMES.length;
export const RHYTHM_COUNT = RHYTHM_NAMES.length;
export const RHYTHM_BUTTON_COUNT = 10;

/**
 * The names of the rhythms the user slots come up with.
 *
 * The 20 user slots are not empty when the machine comes up: they hold the
 * rhythms of the two banks, the ten of bank A and the ten of bank B. The
 * rhythms themselves are the engine's own, and these are their names, in the
 * order of the slots: the ten of bank A come first and the ten of bank B
 * follow them.
 *
 * The names are written here as they are read, the way the factory names
 * are. A name that the user gives to a pattern takes the place of these.
 */
export const ADVANCED_NAMES = [
  'CALYPSO',
  'REGGAE',
  'JAZZ 1',
  'JAZZ 5/4 1',
  'DISCO 1',
  '70S GERMAN',
  'ROCK 5',
  '16 BEAT 1',
  'TECHNO',
  '80S POP 1',
  'BOLERO',
  'MONTUNO',
  'JAZZ 2',
  'JAZZ 5/4 2',
  'DISCO 2',
  '70S FRENCH',
  'ROCK 6',
  '16 BEAT 2',
  'HOUSE',
  '80S POP 2',
] as const;

/**
 * The instruments the band of knobs reaches for, in the engine's voice
 * order: the bass is the first voice and the quijada the last.
 */
export const INSTR_BASS = 0;
export const INSTR_SNARE_1 = 1;
export const INSTR_SNARE_2 = 2;

/**
 * The small bongo is the high one, the voice that stands in for the
 * agogo of the drum kits, and the large bongo is the low one.
 */
export const INSTR_SMALL_BONGO = 3;
export const INSTR_LARGE_BONGO = 4;
export const INSTR_CONGA = 5;
export const INSTR_COWBELL = 6;
export const INSTR_CLAVES = 7;
export const INSTR_HIHAT = 8;
export const INSTR_RIMSHOT = 9;
export const INSTR_CYMBAL_1 = 10;
export const INSTR_CYMBAL_2 = 11;
export const INSTR_TAMBORINE = 12;
export const INSTR_GUIRO = 13;
export const INSTR_QUIJADA = 14;

/**
 * The percussion voices the PERC VOL knob of the band reaches for: the
 * small bongo, the large bongo, the conga, the cowbell, the claves and the
 * rimshot.
 */
export const INSTR_PERCUSSION = [
  INSTR_SMALL_BONGO,
  INSTR_LARGE_BONGO,
  INSTR_CONGA,
  INSTR_COWBELL,
  INSTR_CLAVES,
  INSTR_RIMSHOT,
] as const;

/**
 * The accent flag of a pattern column.
 *
 * The fifteen instruments fill the lower fifteen bits of a column, so the
 * sixteenth one marks the column as accented: every instrument in it is
 * played louder. It is the engine's own flag, `MP7_PATTERN_ACCENT`.
 */
export const PATTERN_ACCENT_BIT = 1 << 15;

/**
 * The time signatures a pattern can carry.
 *
 * A pattern names its time signature, and the engine derives the mask of
 * the steps it plays from it: the 4/4 signature plays every column, the
 * 3/4 signature skips the columns that lie outside its bar, and the 2/4
 * and the 6/8 share the compound grid, where a beat holds six columns
 * instead of eight. The numbers are the engine's own, `mp7_timesig`.
 */
export const TIMESIG = {
  '4/4': 0,
  '2/4': 1,
  '3/4': 2,
  '5/4': 3,
  '6/8': 4,
  '7/4': 5,
} as const;

/** The time signature of a pattern. */
export type TimeSignature = (typeof TIMESIG)[keyof typeof TIMESIG];

/**
 * The time signature of a mask that belongs to no signature.
 *
 * A pattern that was written by hand may carry a mask of its own, and the
 * mask of a combination of patterns with different signatures belongs to
 * none of them.
 */
export const TIMESIG_NONE = -1;

/**
 * The time signature of a number the engine handed over.
 *
 * A number the engine does not know is read as 4/4: it is the signature
 * that plays every column, and it is the one the machine comes up with.
 */
export function timesigOf(value: number): TimeSignature {
  for (const entry of Object.entries(TIMESIG) as [string, TimeSignature][]) {
    if (entry[1] === value) {
      return entry[1];
    }
  }
  return TIMESIG['4/4'];
}

/** The name of a time signature, as the card prints it. */
export function labelOfTimesig(timesig: number): string {
  for (const [label, value] of Object.entries(TIMESIG)) {
    if (value === timesig) {
      return label;
    }
  }
  return '4/4';
}

/** The time signature a name stands for. */
export function timesigOfLabel(label: string): TimeSignature | null {
  for (const [name, value] of Object.entries(TIMESIG)) {
    if (name === label) {
      return value as TimeSignature;
    }
  }
  return null;
}

// The engine's grid is a fixed 64 column cycle. The engine stores a rhythm
// in its shortest repeating period (16, 32 or 64 columns), but a view always
// carries the whole cycle: the period is repeated out to it.
export const PATTERN_COLUMNS = 64;

// The cycle is read as four bars of sixteen steps. A step is a sixteenth
// note at 120 BPM, the tempo the engine takes its columns from.
export const PATTERN_STEPS_PER_BAR = 16;
export const PATTERN_BARS = PATTERN_COLUMNS / PATTERN_STEPS_PER_BAR;

export interface PanelState {
  bank: Bank;
  buttons: number;
  pendingBank: Bank;
  pendingButtons: number;
  pending: boolean;
  running: boolean;
  column: number;
  flashCount: number;
  source: PatternSource;
}

/**
 * A view of a pattern: the grid of the cycle, every voice of it.
 *
 * The engine composes the view, so the panel prints it as it is: the notes
 * of the patterns that are combined are already OR-ed together, the shared
 * percussion layer is already merged in, and the mask is the one the
 * selection plays on.
 */
export interface PatternView {
  /**
   * The 64 columns of the cycle, one bit per voice and the accent flag in
   * the highest bit.
   */
  notes: number[];
  enableLo: number;
  enableHi: number;
  /**
   * The time signature of the pattern.
   *
   * It is the signature the pattern carries, or `TIMESIG_NONE` when the
   * patterns that are combined carry different ones.
   */
  timesig: number;
  /**
   * Whether the pattern plays on the compound grid.
   *
   * The compound grid is the one the 2/4 and the 6/8 play on: a beat
   * holds six columns there and eight on the straight grid.
   */
  compound: boolean;
}

/**
 * A user-defined pattern: the 64 columns of the cycle and the time
 * signature it plays on.
 *
 * A column holds the fifteen instruments in its lower bits and the accent
 * flag in its sixteenth one, so the accent travels with the pattern. The
 * mask of the steps the machine plays is not carried here: the engine
 * derives it from the time signature, and the steps it leaves out are the
 * ones the grid does not use.
 */
export interface UserPattern {
  notes: number[];
  timesig: TimeSignature;
}

export type EngineCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'select'; bank: Bank; buttons: number }
  | { type: 'trigger'; instrument: number; velocity: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'volume'; value: number }
  | { type: 'balance'; value: number }
  | { type: 'instrGain'; instrument: number; value: number }
  | { type: 'instrPan'; instrument: number; value: number }
  | { type: 'snare1Decay'; value: number }
  | { type: 'snare1Cutoff'; value: number }
  | { type: 'hihatCutoff'; value: number }
  | { type: 'accentGain'; value: number }
  | { type: 'spread'; value: number }
  | { type: 'pattern'; bank: Bank; buttons: number }
  | { type: 'source'; source: PatternSource }
  | { type: 'userPattern'; index: number; pattern: UserPattern }
  | { type: 'userPatternRequest'; index: number };

export type EngineEvent =
  | { type: 'ready' }
  | { type: 'panel'; state: PanelState }
  | { type: 'pattern'; bank: Bank; buttons: number; view: PatternView }
  | { type: 'userPattern'; index: number; pattern: UserPattern }
  | { type: 'error'; message: string };

/**
 * The selection the panel starts with: the seventh rhythm key (Rock 1) is
 * latched, the way the machine stands before the first press.
 */
export const INITIAL_SELECTION: { bank: Bank; buttons: number } = {
  bank: 0,
  buttons: 1 << 6,
};

export const INITIAL_PANEL_STATE: PanelState = {
  bank: INITIAL_SELECTION.bank,
  buttons: INITIAL_SELECTION.buttons,
  pendingBank: INITIAL_SELECTION.bank,
  pendingButtons: INITIAL_SELECTION.buttons,
  pending: false,
  running: false,
  column: 0,
  flashCount: 0,
  source: PATTERN_SOURCE_PRESET,
};
