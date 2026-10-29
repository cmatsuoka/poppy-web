import {
  INSTR_COWBELL,
  INSTR_CONGA,
  INSTR_CYMBAL_1,
  INSTR_CYMBAL_2,
  INSTR_GUIRO,
  INSTR_HIHAT,
  INSTR_LARGE_BONGO,
  INSTR_QUIJADA,
  INSTR_RIMSHOT,
  INSTR_SMALL_BONGO,
  INSTR_SNARE_2,
  INSTR_TAMBORINE,
} from './protocol';

const Q16 = 65536;

/**
 * How far every instrument is spread over the stereo field.
 *
 * The number is the part of the way from the centre of the field to its
 * edge: 0.30 is thirty percent of the way to the right and -0.60 sixty
 * percent of the way to the left. The bass drum, the snare 1 and the
 * claves are not in the table: they stay in the centre of the field.
 */
export const STEREO_SPREAD: Readonly<Record<number, number>> = {
  [INSTR_SNARE_2]: 0.3,
  [INSTR_SMALL_BONGO]: 0.5,
  [INSTR_LARGE_BONGO]: 0.5,
  [INSTR_CONGA]: -0.6,
  [INSTR_COWBELL]: 0.8,
  [INSTR_HIHAT]: -0.2,
  [INSTR_RIMSHOT]: -0.7,
  [INSTR_CYMBAL_1]: 0.3,
  [INSTR_CYMBAL_2]: -0.3,
  [INSTR_TAMBORINE]: 0.2,
  [INSTR_GUIRO]: -0.3,
  [INSTR_QUIJADA]: 0.4,
};

/**
 * The instruments the spread knob reaches for.
 *
 * The bass drum, the snare 1 and the claves are not among them: they
 * stay in the centre of the field.
 */
export const SPREAD_INSTRUMENTS = Object.keys(STEREO_SPREAD).map(Number);

/**
 * The place of an instrument in the stereo field, Q16.
 *
 * The knob stands between -1 and 1. At zero every instrument is in the
 * centre of the field, at one every instrument stands as far to its side
 * as the table says it goes, and below zero the whole field is mirrored.
 * The engine's pan law is linear: the number is the part of the signal
 * that goes into the right channel.
 */
export function spreadPanQ16(spread: number, instrument: number): number {
  const offset = STEREO_SPREAD[instrument] ?? 0;
  const pan = Q16 / 2 + spread * offset * (Q16 / 2);
  return Math.round(Math.min(Q16, Math.max(0, pan)));
}
