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

/* int32[8]: notes_ptr, percussion_ptr, enable_lo, enable_hi, notes_period,
 * percussion_period, triplet, valid. Offsets are byte addresses into wasm
 * memory; read notes/percussion through HEAPU16 at offset >> 1. */
static int32_t pattern_out[8];

/* The same layout for a user pattern. It has an array of its own, so a
 * factory pattern and a user pattern can be read at the same time. */
static int32_t user_pattern_out[8];

/* The user pattern the engine copied out of a slot. The notes live in this
 * buffer, so the JS side reads them from a fixed address. */
static struct mp7_user_pattern user_out;

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

WASM_EXPORT int32_t *poppy_factory_pattern(int32_t rhythm)
{
    struct mp7_pattern_view v;

    mp7_get_factory_pattern((mp7_rhythm)rhythm, &v);
    if (v.notes == NULL || v.percussion == NULL) {
        pattern_out[7] = 0;
        return pattern_out;
    }

    pattern_out[0] = (int32_t)(uintptr_t)v.notes;
    pattern_out[1] = (int32_t)(uintptr_t)v.percussion;
    pattern_out[2] = (int32_t)(uint32_t)v.enable;
    pattern_out[3] = (int32_t)(uint32_t)(v.enable >> 32);
    pattern_out[4] = (int32_t)v.notes_period;
    pattern_out[5] = (int32_t)v.percussion_period;
    pattern_out[6] = v.triplet ? 1 : 0;
    pattern_out[7] = 1;
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

/*
 * Fill every user slot with an empty pattern.
 *
 * A user pattern starts blank: the user writes it, step by step, with the
 * write strip. The grid is a full 64-column loop with every column enabled
 * and no instrument in it, so the strip can write all four bars of the
 * cycle. A copy of a factory rhythm would be a pattern the user never
 * wrote, and it would carry the shared Tambourine/Guiro/Quijada layer that
 * the user source never adds on its own.
 */
WASM_EXPORT void poppy_seed_user_patterns(void *ctx)
{
    unsigned int rhythm;

    for (rhythm = 0u; rhythm < (unsigned int)MP7_RHYTHM_COUNT; rhythm++) {
        struct mp7_user_pattern pattern;

        memset(&pattern, 0, sizeof(pattern));
        pattern.enable = ~(uint64_t)0;
        pattern.notes_period = (uint8_t)MP7_USER_PATTERN_COLUMNS;
        pattern.triplet = false;

        mp7_set_user_pattern(ctx, rhythm, &pattern);
    }
}

/* Copy a pattern into a user slot. The notes are read from the wasm heap. */
WASM_EXPORT int32_t poppy_set_user_pattern(void *ctx,
                                            int32_t index,
                                            int32_t notes_ptr,
                                            int32_t enable_lo,
                                            int32_t enable_hi,
                                            int32_t period,
                                            int32_t triplet)
{
    struct mp7_user_pattern pattern;
    const uint16_t *notes = (const uint16_t *)(uintptr_t)notes_ptr;
    unsigned int column;

    if (notes == NULL) {
        return 0;
    }

    memset(&pattern, 0, sizeof(pattern));
    for (column = 0u; column < (unsigned int)MP7_USER_PATTERN_COLUMNS;
         column++) {
        pattern.notes[column] = notes[column];
    }

    pattern.enable = ((uint64_t)(uint32_t)enable_hi << 32) |
                     (uint64_t)(uint32_t)enable_lo;
    pattern.notes_period = (uint8_t)period;
    pattern.triplet = (triplet != 0);

    return mp7_set_user_pattern(ctx, (unsigned int)index, &pattern) ? 1 : 0;
}

/*
 * Read a user slot back.
 *
 * A user pattern carries its own percussion lines, so the view has no
 * shared percussion layer: the second pointer stays empty and the card
 * does not add one.
 */
WASM_EXPORT int32_t *poppy_user_pattern(const void *ctx, int32_t index)
{
    if (!mp7_get_user_pattern(ctx, (unsigned int)index, &user_out)) {
        user_pattern_out[7] = 0;
        return user_pattern_out;
    }

    user_pattern_out[0] = (int32_t)(uintptr_t)user_out.notes;
    user_pattern_out[1] = 0;
    user_pattern_out[2] = (int32_t)(uint32_t)user_out.enable;
    user_pattern_out[3] = (int32_t)(uint32_t)(user_out.enable >> 32);
    user_pattern_out[4] = (int32_t)user_out.notes_period;
    user_pattern_out[5] = 0;
    user_pattern_out[6] = user_out.triplet ? 1 : 0;
    user_pattern_out[7] = 1;
    return user_pattern_out;
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
