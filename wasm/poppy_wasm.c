/*
 * poppy_wasm.c - the only place where libpoppy's mp7.h meets the JS boundary.
 *
 * Every exported function is called from the AudioWorklet thread only.
 * Snapshots are written into static buffers so the JS side never allocates
 * or frees wasm memory for them.
 *
 * The engine is built with LIBPOPPY_EXTRA, so it carries the 20 user
 * pattern slots and the switch that points the sequencer at them. The
 * panel's extended mode writes the user patterns through this file and
 * reads them back the same way.
 *
 * A pattern names its time signature, and the engine derives the mask of
 * the steps it plays from it. The glue hands the signature to the panel
 * and the mask the engine derived from it, so the panel never has to know
 * the masks of the library. The mask also decides the grid the pattern
 * plays on: the compound mask - the mask of the 2/4 and of the 6/8 - plays
 * on the compound grid, every other mask plays straight.
 */

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include <mp7.h>

/* The user pattern slots live behind the extended build of the library. */
#ifndef LIBPOPPY_EXTRA
#error "the glue needs the extended build of libpoppy (-DLIBPOPPY_EXTRA)"
#endif

#define WASM_EXPORT EMSCRIPTEN_KEEPALIVE

/* int32[9]: bank, buttons, pending_bank, pending_buttons, pending, running,
 * column, flash_count, pattern_source. */
static int32_t panel_out[9];

/* int32[9]: notes_ptr, percussion_ptr, enable_lo, enable_hi, notes_period,
 * percussion_period, timesig, compound, valid. Offsets are byte addresses
 * into wasm memory; read notes/percussion through HEAPU16 at offset >> 1.
 *
 * The same layout for a factory pattern and for a user pattern. A user
 * pattern has no shared percussion layer, so its percussion pointer stays
 * empty.
 *
 * The periods are the length of the grid the pointer points at. The view of
 * a factory rhythm carries the whole cycle, so its period is the length of
 * the cycle, and the period of a user pattern is the one the pattern was
 * written with. */
static int32_t pattern_out[9];

/* The view of a factory rhythm. The grid of a view is the whole cycle, so
 * it is copied into this buffer and the JS side reads it from here. */
static struct mp7_pattern_view factory_out;

/* The user pattern the engine copied out of a slot. The notes live in this
 * buffer, so the JS side reads them from a fixed address. */
static struct mp7_user_pattern user_out;

/* The mask of the compound grid: the mask of the 2/4 and of the 6/8. A
 * pattern that carries it plays on the compound grid. */
static uint64_t compound_mask(void)
{
    return mp7_timesig_enable_mask(MP7_TIMESIG_2_4);
}

/* The time signature a mask belongs to, or -1 when it belongs to none.
 *
 * The masks of the signatures are the only masks the library hands out, so
 * a mask that is not one of them does not name a signature. */
static int32_t timesig_of_mask(uint64_t mask)
{
    int32_t timesig;

    for (timesig = 0; timesig < (int32_t)MP7_TIMESIG_COUNT; timesig++) {
        if (mp7_timesig_enable_mask((mp7_timesig)timesig) == mask) {
            return timesig;
        }
    }

    return -1;
}

WASM_EXPORT uint32_t poppy_version(void)
{
    return mp7_version_number();
}

WASM_EXPORT int32_t poppy_instrument_count(void)
{
    return MP7_INSTR_COUNT;
}

WASM_EXPORT int32_t poppy_rhythm_count(void)
{
    return MP7_RHYTHM_COUNT;
}

WASM_EXPORT void *poppy_create(uint32_t sample_rate)
{
    return mp7_create_context(sample_rate);
}

WASM_EXPORT void poppy_destroy(void *ctx)
{
    mp7_destroy_context(ctx);
}

WASM_EXPORT void poppy_reset(void *ctx)
{
    mp7_reset(ctx);
}

WASM_EXPORT void poppy_process(void *ctx, int16_t *stereo_out, int32_t frames)
{
    mp7_process(ctx, stereo_out, (size_t)frames);
}

WASM_EXPORT void poppy_trigger(void *ctx, int32_t instrument, int32_t velocity)
{
    mp7_trigger(ctx, (mp7_instr)instrument, (uint8_t)velocity);
}

WASM_EXPORT void poppy_select_rhythm(void *ctx, int32_t bank, int32_t buttons)
{
    mp7_select_rhythm(ctx, (mp7_bank)bank, (uint16_t)buttons);
}

WASM_EXPORT void poppy_stop_rhythms(void *ctx)
{
    mp7_stop_rhythms(ctx);
}

WASM_EXPORT void poppy_set_tempo(void *ctx, int32_t bpm)
{
    mp7_set_tempo(ctx, (uint16_t)bpm);
}

WASM_EXPORT void poppy_set_volume(void *ctx, int32_t q16)
{
    mp7_set_volume(ctx, q16);
}

WASM_EXPORT void poppy_set_balance(void *ctx, int32_t q16)
{
    mp7_set_balance(ctx, q16);
}

WASM_EXPORT void poppy_set_instr_gain(void *ctx, int32_t instrument, int32_t q16)
{
    mp7_set_instr_gain(ctx, (mp7_instr)instrument, q16);
}

/* The place of an instrument in the stereo field, Q16.
 *
 * The engine's pan law is linear: 0 is hard left, 65536 is hard right and
 * 32768 - the default of every instrument - is the centre of the field. */
WASM_EXPORT void poppy_set_instr_pan(void *ctx, int32_t instrument, int32_t pan)
{
    mp7_set_instr_pan(ctx, (mp7_instr)instrument, pan);
}

/* The decay of the snare 1, as a multiplier of the factory decay, Q16.
 *
 * 65536 is the factory decay and the engine clamps the multiplier to a
 * quarter and to four times the factory decay. */
WASM_EXPORT void poppy_set_snare1_decay(void *ctx, int32_t decay_q16)
{
    mp7_set_snare1_decay(ctx, decay_q16);
}

/* The centre of the band-pass of the snare 1, in Hz. The engine clamps it
 * to the range of the parameter and to two fifths of the sample rate. */
WASM_EXPORT void poppy_set_snare1_cutoff(void *ctx, int32_t cutoff_hz)
{
    mp7_set_snare1_cutoff(ctx, (uint32_t)cutoff_hz);
}

/* The corner of the high-pass of the hi-hat, in Hz. The engine clamps it
 * to the range of the parameter and to two fifths of the sample rate. */
WASM_EXPORT void poppy_set_hihat_cutoff(void *ctx, int32_t cutoff_hz)
{
    mp7_set_hihat_cutoff(ctx, (uint32_t)cutoff_hz);
}

/* The gain an accented column is played at, Q16. */
WASM_EXPORT void poppy_set_accent_gain(void *ctx, int32_t q16)
{
    mp7_set_accent_gain(ctx, q16);
}

WASM_EXPORT int32_t *poppy_panel_state(const void *ctx)
{
    struct mp7_panel_state s;

    mp7_get_panel_state(ctx, &s);
    panel_out[0] = (int32_t)s.bank;
    panel_out[1] = (int32_t)s.buttons;
    panel_out[2] = (int32_t)s.pending_bank;
    panel_out[3] = (int32_t)s.pending_buttons;
    panel_out[4] = s.pending ? 1 : 0;
    panel_out[5] = s.running ? 1 : 0;
    panel_out[6] = (int32_t)s.column;
    panel_out[7] = (int32_t)s.flash_count;
    panel_out[8] = (mp7_get_pattern_source(ctx) == MP7_PATTERN_SOURCE_USER)
                       ? 1
                       : 0;
    return panel_out;
}

/*
 * The view of a factory rhythm.
 *
 * The engine hands over the whole 64-column cycle: the period a rhythm is
 * stored in is repeated out to the cycle before it reaches the panel. A
 * rhythm that does not exist comes back as an empty view - a grid of
 * nothing and a mask of nothing - and is refused here.
 */
WASM_EXPORT int32_t *poppy_factory_pattern(int32_t rhythm)
{
    mp7_get_factory_pattern((mp7_rhythm)rhythm, &factory_out);

    if (factory_out.enable == 0) {
        pattern_out[8] = 0;
        return pattern_out;
    }

    pattern_out[0] = (int32_t)(uintptr_t)factory_out.notes;
    pattern_out[1] = (int32_t)(uintptr_t)factory_out.percussion;
    pattern_out[2] = (int32_t)(uint32_t)factory_out.enable;
    pattern_out[3] = (int32_t)(uint32_t)(factory_out.enable >> 32);
    pattern_out[4] = (int32_t)MP7_PATTERN_COLUMNS;
    pattern_out[5] = (int32_t)MP7_PATTERN_COLUMNS;
    pattern_out[6] = timesig_of_mask(factory_out.enable);
    pattern_out[7] = (factory_out.enable == compound_mask()) ? 1 : 0;
    pattern_out[8] = 1;
    return pattern_out;
}

/* Point the sequencer at the factory rhythms or at the user slots. */
WASM_EXPORT void poppy_set_pattern_source(void *ctx, int32_t source)
{
    mp7_set_pattern_source(ctx, (source == 1) ? MP7_PATTERN_SOURCE_USER
                                             : MP7_PATTERN_SOURCE_PRESET);
}

WASM_EXPORT int32_t poppy_get_pattern_source(const void *ctx)
{
    return (mp7_get_pattern_source(ctx) == MP7_PATTERN_SOURCE_USER) ? 1 : 0;
}

/* Copy a pattern into a user slot. The notes are read from the wasm heap.
 *
 * The pattern names its time signature, and the engine derives the mask of
 * the steps it plays from it. A signature the engine does not know is
 * refused, and the slot is left alone. */
WASM_EXPORT int32_t poppy_set_user_pattern(void *ctx,
                                            int32_t index,
                                            int32_t notes_ptr,
                                            int32_t timesig,
                                            int32_t period)
{
    struct mp7_user_pattern pattern;
    const uint16_t *notes = (const uint16_t *)(uintptr_t)notes_ptr;
    unsigned int column;

    if (notes == NULL) {
        return 0;
    }
    if ((unsigned int)timesig >= (unsigned int)MP7_TIMESIG_COUNT) {
        return 0;
    }

    memset(&pattern, 0, sizeof(pattern));
    for (column = 0u; column < (unsigned int)MP7_USER_PATTERN_COLUMNS;
         column++) {
        pattern.notes[column] = notes[column];
    }

    pattern.timesig = (mp7_timesig)timesig;
    pattern.notes_period = (uint8_t)period;

    return mp7_set_user_pattern(ctx, (unsigned int)index, &pattern) ? 1 : 0;
}

/*
 * Read a user slot back.
 *
 * The mask the panel prints is the one the engine derived from the
 * signature of the slot, and the signature itself is handed along, so the
 * panel can name the meter of the pattern.
 *
 * A user pattern carries its own percussion lines, so the view has no
 * shared percussion layer: the second pointer stays empty and the card
 * does not add one.
 */
WASM_EXPORT int32_t *poppy_user_pattern(const void *ctx, int32_t index)
{
    uint64_t mask;

    if (!mp7_get_user_pattern(ctx, (unsigned int)index, &user_out)) {
        pattern_out[8] = 0;
        return pattern_out;
    }

    mask = mp7_timesig_enable_mask(user_out.timesig);

    pattern_out[0] = (int32_t)(uintptr_t)user_out.notes;
    pattern_out[1] = 0;
    pattern_out[2] = (int32_t)(uint32_t)mask;
    pattern_out[3] = (int32_t)(uint32_t)(mask >> 32);
    pattern_out[4] = (int32_t)user_out.notes_period;
    pattern_out[5] = 0;
    pattern_out[6] = (int32_t)user_out.timesig;
    pattern_out[7] = (mask == compound_mask()) ? 1 : 0;
    pattern_out[8] = 1;
    return pattern_out;
}

/*
 * The pattern that is in effect for a rhythm: the factory rhythm while the
 * preset source is selected, the user slot while the user source is.
 */
WASM_EXPORT int32_t *poppy_pattern(const void *ctx, int32_t rhythm)
{
    if (mp7_get_pattern_source(ctx) == MP7_PATTERN_SOURCE_USER) {
        return poppy_user_pattern(ctx, rhythm);
    }
    return poppy_factory_pattern(rhythm);
}
