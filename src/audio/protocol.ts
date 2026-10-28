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
 * The instruments the band of knobs reaches for, in the engine's voice
 * order: the snare is the second voice, the hi-hat the ninth.
 */
export const INSTR_SNARE_1 = 1;
export const INSTR_HIHAT = 8;

/**
 * The parameters of a voice the engine can move.
 *
 * The numbers are the order of the engine's own list of them, so the panel
 * and the engine speak the same names. The units are the ones the engine
 * uses: Q16 for the volume, microseconds for the times, Hz for the
 * frequencies and Q8.8 for the resonance.
 */
export const VOICE_PARAM = {
  volume: 0,
  attack: 1,
  decay: 2,
  cutoff: 3,
  highpass: 4,
  resonance: 5,
} as const;

export type VoiceParam = (typeof VOICE_PARAM)[keyof typeof VOICE_PARAM];

/**
 * The accent flag of a pattern column.
 *
 * The fifteen instruments fill the lower fifteen bits of a column, so the
 * sixteenth one marks the column as accented: every instrument in it is
 * played louder. It is the engine's own flag, `MP7_PATTERN_ACCENT`.
 */
export const PATTERN_ACCENT_BIT = 1 << 15;

// The engine's grid is a fixed 64 column cycle. A rhythm may store only its
// shortest repeating period (16, 32 or 64 columns); the rest of the cycle
// repeats it.
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

export interface PatternView {
  rhythm: number;
  notes: number[];
  percussion: number[];
  enableLo: number;
  enableHi: number;
  notesPeriod: number;
  percussionPeriod: number;
  triplet: boolean;
}

/**
 * A user-defined pattern: the 64 columns of the cycle, the columns that
 * take time, the length of the repeating part and the shuffle flag.
 *
 * A column holds the fifteen instruments in its lower bits and the accent
 * flag in its sixteenth one, so the accent travels with the pattern.
 */
export interface UserPattern {
  notes: number[];
  enableLo: number;
  enableHi: number;
  period: number;
  triplet: boolean;
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
  | { type: 'voiceParam'; instrument: number; param: VoiceParam; value: number }
  | { type: 'accentGain'; value: number }
  | { type: 'pattern'; rhythm: number }
  | { type: 'source'; source: PatternSource }
  | { type: 'userPattern'; index: number; pattern: UserPattern }
  | { type: 'userPatternRequest'; index: number };

export type EngineEvent =
  | { type: 'ready' }
  | { type: 'panel'; state: PanelState }
  | { type: 'pattern'; view: PatternView }
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
