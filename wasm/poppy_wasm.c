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

/* The layout of a pattern view: int32[8].
 *
 *   0  the address of the grid; read it through HEAPU16 at (address >> 1)
 *   1  the low half of the step-enable mask
 *   2  the high half of the step-enable mask
 *   3  the time signature of the pattern, or -1 when it has none
 *   4  1 when the pattern plays on the compound grid
 *   5  1 when the view is valid
 *   6  the number of columns of the grid
 *   7  the length of the repeating part of the grid
 */
static int32_t view_out[8];

/* The layout of a user slot: int32[3].
 *
 *   0  the address of the grid; read it through HEAPU16 at (address >> 1)
 *   1  the time signature of the slot
 *   2  1 when the slot is not empty
 */
static int32_t slot_out[3];

/* The view the engine fills. The grid of a view is the whole cycle, so it
 * is copied into this buffer and the JS side reads it from here. */
static struct mp7_pattern_view pattern_view;

/* The user pattern the engine copied out of a slot. The notes live in this
 * buffer, so the JS side reads them from a fixed address. */
static struct mp7_user_pattern user_out;

/* Fill the layout of a view.
 *
 * The grid is the whole cycle of the pattern, every voice of it, so the
 * panel prints it as it is. */
static void fill_view(const struct mp7_pattern_view *view)
{
    view_out[0] = (int32_t)(uintptr_t)view->notes;
    view_out[1] = (int32_t)(uint32_t)view->enable;
    view_out[2] = (int32_t)(uint32_t)(view->enable >> 32);
    view_out[3] = (int32_t)view->timesig;
    view_out[4] = view->compound ? 1 : 0;
    view_out[5] = 1;
    view_out[6] = (int32_t)MP7_PATTERN_COLUMNS;
    view_out[7] = (int32_t)MP7_PATTERN_COLUMNS;
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
 * 32768 - the default of every instrument - is the center of the field. */
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
    mp7_set_instr_decay(ctx, MP7_INSTR_SNARE_1, decay_q16);
}

/* The center of the band-pass of the snare 1, in Hz. The engine clamps it
 * to the range of the parameter and to two fifths of the sample rate. */
WASM_EXPORT void poppy_set_snare1_cutoff(void *ctx, int32_t cutoff_hz)
{
    mp7_set_instr_cutoff(ctx, MP7_INSTR_SNARE_1, (uint32_t)cutoff_hz);
}

/* The center of the band-pass of the hi-hat, in Hz. The engine clamps it
 * to the range of the parameter and to two fifths of the sample rate. The
 * high-pass of the hi-hat stays at the factory corner. */
WASM_EXPORT void poppy_set_hihat_cutoff(void *ctx, int32_t cutoff_hz)
{
    mp7_set_instr_cutoff(ctx, MP7_INSTR_HIHAT, (uint32_t)cutoff_hz);
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
 * The view of a selection: the composition of the rhythms that are
 * latched, the way the sequencer plays it.
 *
 * The engine composes it, so the panel does not have to know that the
 * notes are OR-ed together, that the masks are AND-ed, or that the shared
 * percussion layer plays with every factory rhythm. A selection of one
 * rhythm is the view of that rhythm.
 */
WASM_EXPORT int32_t *poppy_selection_pattern(void *ctx,
                                              int32_t bank,
                                              int32_t buttons)
{
    mp7_get_selection_pattern(ctx, (mp7_bank)bank, (uint16_t)buttons,
                               &pattern_view);

    fill_view(&pattern_view);
    return view_out;
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
                                            int32_t timesig)
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

    return mp7_set_user_pattern(ctx, (unsigned int)index, &pattern) ? 1 : 0;
}

/*
 * Read a user slot back.
 *
 * The slot carries its own grid and the signature it plays on, and the
 * panel edits them and writes them back. The grid is the one that is
 * stored: the grid is the whole cycle, and the steps the machine leaves
 * out are masked out by the signature.
 */
WASM_EXPORT int32_t *poppy_user_pattern(const void *ctx, int32_t index)
{
    if (!mp7_get_user_pattern(ctx, (unsigned int)index, &user_out)) {
        slot_out[2] = 0;
        return slot_out;
    }

    slot_out[0] = (int32_t)(uintptr_t)user_out.notes;
    slot_out[1] = (int32_t)user_out.timesig;
    slot_out[2] = 1;
    return slot_out;
}

