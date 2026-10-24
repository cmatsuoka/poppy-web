export type Bank = 0 | 1;

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

export interface PanelState {
  bank: Bank;
  buttons: number;
  pendingBank: Bank;
  pendingButtons: number;
  pending: boolean;
  running: boolean;
  column: number;
  flashCount: number;
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

export type EngineCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'select'; bank: Bank; buttons: number }
  | { type: 'trigger'; instrument: number; velocity: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'volume'; value: number }
  | { type: 'balance'; value: number }
  | { type: 'instrGain'; instrument: number; value: number }
  | { type: 'pattern'; rhythm: number };

export type EngineEvent =
  | { type: 'ready' }
  | { type: 'panel'; state: PanelState }
  | { type: 'pattern'; view: PatternView }
  | { type: 'error'; message: string };

export const INITIAL_PANEL_STATE: PanelState = {
  bank: 0,
  buttons: 0,
  pendingBank: 0,
  pendingButtons: 0,
  pending: false,
  running: false,
  column: 0,
  flashCount: 0,
};
