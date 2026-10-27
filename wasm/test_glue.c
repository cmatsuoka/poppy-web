/*
 * test_glue.c - a native check for wasm/poppy_wasm.c.
 *
 * The glue is Emscripten code, but it is plain C: the stub
 * emscripten/emscripten.h lets it be compiled with the host compiler
 * against the same library sources the wasm build uses. The check covers
 * the parts the panel depends on: the empty user patterns the engine starts
 * with, the source switch, the round trip through a user slot and the
 * accent flag of a column.
 *
 * The glue keeps its pointers in int32, which is what wasm wants but not
 * what a 64-bit host build wants. The binary is therefore linked
 * non-PIE, so the addresses fit into the int32 the glue hands out.
 */

#include <stdio.h>
#include <string.h>
#include <stdint.h>

#include <mp7.h>

#include "poppy_wasm.c"

static int failures = 0;

static void check(int ok, const char *what)
{
    printf("%s : %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        failures++;
    }
}

/* The loudest sample of a rendered block, so two renders can be compared. */
static int peak(const int16_t *samples, int count)
{
    int loudest = 0;

    for (int i = 0; i < count; i++) {
        int value = samples[i] < 0 ? -samples[i] : samples[i];

        if (value > loudest) {
            loudest = value;
        }
    }
    return loudest;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);

    void *ctx = poppy_create(44100);
    check(ctx != 0, "the context is allocated");
    poppy_seed_user_patterns(ctx);

    /* Every seeded slot is empty: no instrument plays, every column of the
     * cycle is enabled and the grid is a full 64 columns long, so the write
     * strip can write all four bars. */
    for (int rhythm = 0; rhythm < MP7_RHYTHM_COUNT; rhythm++) {
        struct mp7_user_pattern slot;
        int empty = 1;

        if (!mp7_get_user_pattern(ctx, (unsigned int)rhythm, &slot)) {
            printf("FAIL : slot %d is empty\n", rhythm);
            failures++;
            continue;
        }

        for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
            if (slot.notes[column] != 0) {
                empty = 0;
            }
        }
        if (slot.enable != ~(uint64_t)0 || slot.triplet != 0) {
            empty = 0;
        }
        if (slot.notes_period != MP7_USER_PATTERN_COLUMNS) {
            empty = 0;
        }
        if (!empty) {
            printf("FAIL : slot %d is not empty\n", rhythm);
            failures++;
        }
    }
    check(failures == 0, "every seeded slot is an empty pattern");

    /* The user source plays the empty pattern in silence, the preset source
     * plays the factory rhythm. */
    static int16_t preset[20480];
    static int16_t user[20480];

    poppy_reset(ctx);
    poppy_seed_user_patterns(ctx);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, preset + i * 512 * 2, 512);
    }

    poppy_reset(ctx);
    poppy_seed_user_patterns(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, user + i * 512 * 2, 512);
    }

    check(peak(preset, 20480) > 0, "the preset source plays the factory rhythm");
    check(peak(user, 20480) == 0, "the user source plays the empty pattern");

    /* A written pattern comes back as it was written. */
    static uint16_t notes[MP7_USER_PATTERN_COLUMNS];
    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)((column % 8) == 0 ? (1u << 0) : 0);
    }

    check(poppy_set_user_pattern(ctx, 3, (int32_t)(uintptr_t)notes, -1, -1, 64,
                                 0) == 1,
          "a pattern is written into a slot");

    struct mp7_user_pattern read;
    check(mp7_get_user_pattern(ctx, 3, &read), "the slot can be read back");
    check(memcmp(read.notes, notes, sizeof(notes)) == 0,
          "the notes come back unchanged");
    check(read.enable == ~(uint64_t)0, "the enable mask comes back unchanged");
    check(read.notes_period == 64, "the period comes back unchanged");
    check(poppy_set_user_pattern(ctx, 99, (int32_t)(uintptr_t)notes, -1, -1, 64,
                                 0) == 0,
          "a slot out of range is refused");

    /* An accented column comes back as it was written, accent flag and all. */
    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)(((column % 8) == 0 ? (1u << 0) : 0) |
                                    MP7_PATTERN_ACCENT);
    }
    check(poppy_set_user_pattern(ctx, 4, (int32_t)(uintptr_t)notes, -1, -1, 64,
                                 0) == 1,
          "an accented pattern is written into a slot");
    check(mp7_get_user_pattern(ctx, 4, &read), "the accented slot can be read");
    check(memcmp(read.notes, notes, sizeof(notes)) == 0,
          "the accent flag comes back unchanged");

    /* The accent is heard: the same pattern plays louder with it. The
     * pattern hits on every column, so the render catches a hit wherever
     * the playhead happens to be. */
    static int16_t plain[20480];
    static int16_t accented[20480];

    poppy_reset(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_set_instr_gain(ctx, MP7_INSTR_BASS, 16384);
    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)(1u << 0);
    }
    poppy_set_user_pattern(ctx, 5, (int32_t)(uintptr_t)notes, -1, -1, 64, 0);
    poppy_select_rhythm(ctx, 0, 1 << 5);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, plain + i * 512 * 2, 512);
    }

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)((1u << 0) | MP7_PATTERN_ACCENT);
    }
    poppy_set_user_pattern(ctx, 5, (int32_t)(uintptr_t)notes, -1, -1, 64, 0);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, accented + i * 512 * 2, 512);
    }

    int plain_peak = peak(plain, 20480);
    int accented_peak = peak(accented, 20480);
    check(plain_peak > 0, "the written pattern is heard");
    check(accented_peak > plain_peak, "the accented pattern is louder");

    /* The source switch is reported, and the panel state carries it. */
    check(poppy_get_pattern_source(ctx) == 1, "the source is the user source");
    int32_t *panel = poppy_panel_state(ctx);
    check(panel[8] == 1, "the panel state reports the user source");
    poppy_set_pattern_source(ctx, 0);
    check(poppy_get_pattern_source(ctx) == 0, "the source is the preset source");

    poppy_destroy(ctx);
    printf("%s\n",
           failures == 0 ? "all glue checks passed" : "there were failures");
    return failures == 0 ? 0 : 1;
}
