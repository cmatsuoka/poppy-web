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

/**
 * The place of every instrument in the stereo field, the way the machine
 * prints it.
 *
 * The number is the part of the way from the center of the field to its
 * edge: 0.30 is thirty percent of the way to the right and -0.60 sixty
 * percent of the way to the left. The bass drum, the snare 1 and the
 * claves are not in the table: they stay in the center of the field.
 *
 * The PAN knob of the band moves one instrument away from the center of
 * the field itself. This table is no longer a control of its own: it is
 * the print the machine comes up with, and the settings the first memory
 * position is seeded with are half of the way the table says.
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
 * The place an instrument is seeded with, in the units of the PAN knob.
 *
 * The PAN knob stands between -1 and 1, with the center of the field in
 * the middle. The first memory position comes up with the instrument at
 * half of the way to its side in the table, the way the machine's print
 * would sound spread softly.
 */
export function seedPan(instrument: number): number {
  return (STEREO_SPREAD[instrument] ?? 0) / 2;
}
