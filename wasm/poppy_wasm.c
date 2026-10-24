/*
 * poppy_wasm.c - the only place where libpoppy's mp7.h meets the JS boundary.
 *
 * Every exported function is called from the AudioWorklet thread only.
 * Snapshots are written into static buffers so the JS side never allocates
 * or frees wasm memory for them.
 */

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdbool.h>

#include <mp7.h>

#define WASM_EXPORT EMSCRIPTEN_KEEPALIVE

/* int32[8]: bank, buttons, pending_bank, pending_buttons, pending, running,
 * column, flash_count. */
static int32_t panel_out[8];

/* int32[8]: notes_ptr, percussion_ptr, enable_lo, enable_hi, notes_period,
 * percussion_period, triplet, valid. Offsets are byte addresses into wasm
 * memory; read notes/percussion through HEAPU16 at offset >> 1. */
static int32_t pattern_out[8];

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
