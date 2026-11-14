/*
 * poppy_wasm.c - the only place where libpops's pops.h meets the JS boundary.
 *
 * Every exported function is called from the AudioWorklet thread only.
 * Snapshots are written into static buffers so the JS side never allocates
 * or frees wasm memory for them.
 *
 * The engine is built with LIBPOPS_EXTRA, so it carries the 20 user
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

#include <pops.h>

/* The user pattern slots live behind the extended build of the library. */
#ifndef LIBPOPS_EXTRA
#error "the glue needs the extended build of libpops (-DLIBPOPS_EXTRA)"
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
static struct pops_pattern_view pattern_view;

/* The user pattern the engine copied out of a slot. The notes live in this
 * buffer, so the JS side reads them from a fixed address. */
static struct pops_user_pattern user_out;

/* Fill the layout of a view.
 *
 * The grid is the whole cycle of the pattern, every voice of it, so the
 * panel prints it as it is. */
static void fill_view(const struct pops_pattern_view *view)
{
    view_out[0] = (int32_t)(uintptr_t)view->notes;
    view_out[1] = (int32_t)(uint32_t)view->enable;
    view_out[2] = (int32_t)(uint32_t)(view->enable >> 32);
    view_out[3] = (int32_t)view->timesig;
    view_out[4] = view->compound ? 1 : 0;
    view_out[5] = 1;
    view_out[6] = (int32_t)POPS_PATTERN_COLUMNS;
    view_out[7] = (int32_t)POPS_PATTERN_COLUMNS;
}

WASM_EXPORT uint32_t poppy_version(void)
{
    return pops_version_number();
}

WASM_EXPORT int32_t poppy_instrument_count(void)
{
    return POPS_INSTR_COUNT;
}

WASM_EXPORT int32_t poppy_rhythm_count(void)
{
    return POPS_RHYTHM_COUNT;
}

WASM_EXPORT void *poppy_create(uint32_t sample_rate)
{
    return pops_create_context(sample_rate);
}

WASM_EXPORT void poppy_destroy(void *ctx)
{
    pops_destroy_context(ctx);
}

WASM_EXPORT void poppy_reset(void *ctx)
{
    pops_reset(ctx);
}

WASM_EXPORT void poppy_process(void *ctx, int16_t *stereo_out, int32_t frames)
{
    pops_process(ctx, stereo_out, (size_t)frames);
}

WASM_EXPORT void poppy_trigger(void *ctx, int32_t instrument, int32_t velocity)
{
    pops_trigger(ctx, (pops_instr)instrument, (uint8_t)velocity);
}

WASM_EXPORT void poppy_select_rhythm(void *ctx, int32_t bank, int32_t buttons)
{
    pops_select_rhythm(ctx, (pops_bank)bank, (uint16_t)buttons);
}

WASM_EXPORT void poppy_stop_rhythms(void *ctx)
{
    pops_stop_rhythms(ctx);
}

WASM_EXPORT void poppy_set_tempo(void *ctx, int32_t bpm)
{
    pops_set_tempo(ctx, (uint16_t)bpm, 0u);
}

/* The tempo in microseconds per quarter note, the tempo format of MIDI
 * clocks and MIDI files: 500000 is 120 BPM. The engine clamps it to its
 * range (240 BPM down to 1 BPM), and the conversion into the beat period
 * is exact, so a host that follows an external clock does not accumulate
 * drift against it. */
WASM_EXPORT void poppy_set_tempo_us(void *ctx, int32_t us_per_quarter)
{
    pops_set_tempo_us(ctx, (uint32_t)us_per_quarter);
}

WASM_EXPORT void poppy_set_volume(void *ctx, int32_t q16)
{
    pops_set_volume(ctx, q16);
}

WASM_EXPORT void poppy_set_balance(void *ctx, int32_t q16)
{
    pops_set_balance(ctx, q16);
}

WASM_EXPORT void poppy_set_instr_gain(void *ctx, int32_t instrument, int32_t q16)
{
    pops_set_instr_gain(ctx, (pops_instr)instrument, q16);
}

/* The place of an instrument in the stereo field, Q16.
 *
 * The engine's pan law is linear: 0 is hard left, 65536 is hard right and
 * 32768 - the default of every instrument - is the center of the field. */
WASM_EXPORT void poppy_set_instr_pan(void *ctx, int32_t instrument, int32_t pan)
{
    pops_set_instr_pan(ctx, (pops_instr)instrument, pan);
}

/* The decay of an instrument, as a multiplier of its factory decay, Q16.
 *
 * 65536 is the factory decay and the engine clamps the multiplier to a
 * fifth and to five times the factory decay. The engine takes the
 * multiplier for every instrument but the guiro, whose length is the
 * gate the rhythm holds open, and ignores it for the guiro. */
WASM_EXPORT void poppy_set_instr_decay(void *ctx, int32_t instrument,
                                       int32_t decay_q16)
{
    pops_set_instr_decay(ctx, (pops_instr)instrument, decay_q16);
}

/* The center of the band-pass of an instrument, in Hz. The engine clamps
 * it to the range of the parameter and to two fifths of the sample rate.
 * The engine takes the cut-off for the snare 1, the snare 2 and the
 * hi-hat, and ignores it for every other instrument. The high-pass of the
 * hi-hat stays at the factory corner. */
WASM_EXPORT void poppy_set_instr_cutoff(void *ctx, int32_t instrument,
                                        int32_t cutoff_hz)
{
    pops_set_instr_cutoff(ctx, (pops_instr)instrument, (uint32_t)cutoff_hz);
}

/* The noise high-pass of an instrument, in Hz.
 *
 * The engine clamps it to the range of the parameter and to two fifths of
 * the sample rate. The engine takes the high-pass for the two cymbals,
 * whose band-pass is fixed, and ignores it for every other instrument. */
WASM_EXPORT void poppy_set_instr_highpass(void *ctx, int32_t instrument,
                                          int32_t highpass_hz)
{
    pops_set_instr_highpass(ctx, (pops_instr)instrument,
                             (uint32_t)highpass_hz);
}

/* The tuning of an instrument, Q16: 65536 is the factory pitch, 32768 an
 * octave down and 131072 an octave up. The engine clamps the multiplier to
 * half and to twice the factory pitch, and it takes the tuning of every
 * instrument. A note that is sounding retunes from the next sample. */
WASM_EXPORT void poppy_set_instr_tune(void *ctx, int32_t instrument,
                                      int32_t tune_q16)
{
    pops_set_instr_tune(ctx, (pops_instr)instrument, tune_q16);
}

/* The reverb send level of an instrument, Q16.
 *
 * 0 sends nothing and 65536 sends the instrument's post-gain, post-pan
 * signal to the bus at full level. The bus renders only in a build with
 * LIBPOPS_FX_REVERB; without it the sends are stored but never heard. */
WASM_EXPORT void poppy_set_instr_fx_send(void *ctx, int32_t instrument,
                                         int32_t send_q16)
{
    pops_set_instr_fx_send(ctx, (pops_instr)instrument, send_q16);
}

/* The gain an accented column is played at, Q16. */
WASM_EXPORT void poppy_set_accent_gain(void *ctx, int32_t q16)
{
    pops_set_accent_gain(ctx, q16);
}

WASM_EXPORT int32_t *poppy_panel_state(const void *ctx)
{
    struct pops_panel_state s;

    pops_get_panel_state(ctx, &s);
    panel_out[0] = (int32_t)s.bank;
    panel_out[1] = (int32_t)s.buttons;
    panel_out[2] = (int32_t)s.pending_bank;
    panel_out[3] = (int32_t)s.pending_buttons;
    panel_out[4] = s.pending ? 1 : 0;
    panel_out[5] = s.running ? 1 : 0;
    panel_out[6] = (int32_t)s.column;
    panel_out[7] = (int32_t)s.flash_count;
    panel_out[8] = (pops_get_pattern_source(ctx) == POPS_PATTERN_SOURCE_USER)
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
    pops_get_selection_pattern(ctx, (pops_bank)bank, (uint16_t)buttons,
                               &pattern_view);

    fill_view(&pattern_view);
    return view_out;
}

/* Point the sequencer at the factory rhythms or at the user slots. */
WASM_EXPORT void poppy_set_pattern_source(void *ctx, int32_t source)
{
    pops_set_pattern_source(ctx, (source == 1) ? POPS_PATTERN_SOURCE_USER
                                             : POPS_PATTERN_SOURCE_PRESET);
}

WASM_EXPORT int32_t poppy_get_pattern_source(const void *ctx)
{
    return (pops_get_pattern_source(ctx) == POPS_PATTERN_SOURCE_USER) ? 1 : 0;
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
    struct pops_user_pattern pattern;
    const uint16_t *notes = (const uint16_t *)(uintptr_t)notes_ptr;
    unsigned int column;

    if (notes == NULL) {
        return 0;
    }
    if ((unsigned int)timesig >= (unsigned int)POPS_TIMESIG_COUNT) {
        return 0;
    }

    memset(&pattern, 0, sizeof(pattern));
    for (column = 0u; column < (unsigned int)POPS_USER_PATTERN_COLUMNS;
         column++) {
        pattern.notes[column] = notes[column];
    }

    pattern.timesig = (pops_timesig)timesig;

    return pops_set_user_pattern(ctx, (unsigned int)index, &pattern) ? 1 : 0;
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
    if (!pops_get_user_pattern(ctx, (unsigned int)index, &user_out)) {
        slot_out[2] = 0;
        return slot_out;
    }

    slot_out[0] = (int32_t)(uintptr_t)user_out.notes;
    slot_out[1] = (int32_t)user_out.timesig;
    slot_out[2] = 1;
    return slot_out;
}

