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

/* Put a user pattern into a slot and select it. The reset comes first, so
 * the pattern starts at the same place in every render. */
static void prepare_pattern(void *ctx, int slot, const uint16_t *notes)
{
    poppy_reset(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_set_user_pattern(ctx, slot, (int32_t)(uintptr_t)notes, -1, -1, 64, 0);
    poppy_select_rhythm(ctx, 0, 1 << slot);
}

/* Render the pattern that is selected. The count is in samples: a block of
 * 512 frames is 1024 samples of stereo. */
static void render(void *ctx, int16_t *out, int samples)
{
    for (int i = 0; i < samples / 1024; i++) {
        poppy_process(ctx, out + i * 1024, 512);
    }
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

    /* A meter mask: the steps outside the bar of the meter are skipped.
     * The mask comes back as it was written, and the sequencer never visits
     * a step the mask leaves out. */
    check(poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes, 0x0FFF0FFF,
                                 0x0FFF0FFF, 64, 0) == 1,
          "a pattern with a meter mask is written into a slot");
    check(mp7_get_user_pattern(ctx, 6, &read), "the slot with a mask is read");
    check(read.enable == UINT64_C(0x0FFF0FFF0FFF0FFF),
          "the meter mask comes back unchanged");

    static int16_t masked[65536];
    int skipped = 0;

    poppy_reset(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes, 0x0FFF0FFF,
                            0x0FFF0FFF, 64, 0);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    for (int i = 0; i < 64; i++) {
        poppy_process(ctx, masked + i * 512 * 2, 512);
        int column = poppy_panel_state(ctx)[6];
        if ((column % 16) >= 12) {
            skipped = 1;
        }
    }
    check(skipped == 0, "the sequencer never visits a skipped step");

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

    /* The accent gain is the engine's own: an accented column is played at
     * the gain the engine was given. Two renders that differ only in that
     * gain are compared with each other. */
    static int16_t plain_accent[20480];
    static int16_t unity_accent[20480];
    static int16_t loud_accent[20480];

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)(1u << 0);
    }
    prepare_pattern(ctx, 8, notes);
    render(ctx, plain_accent, 20480);

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)((1u << 0) | MP7_PATTERN_ACCENT);
    }
    prepare_pattern(ctx, 8, notes);
    poppy_set_accent_gain(ctx, 65536);
    render(ctx, unity_accent, 20480);

    prepare_pattern(ctx, 8, notes);
    poppy_set_accent_gain(ctx, 2 * 65536);
    render(ctx, loud_accent, 20480);

    check(memcmp(plain_accent, unity_accent, sizeof(plain_accent)) == 0,
          "an accent at unity plays like no accent at all");
    check(peak(loud_accent, 20480) > peak(unity_accent, 20480),
          "a higher accent gain is louder");

    /* The adjustable parameters of a voice: the level, the decay and the
     * centre of the band-pass. The snare is the voice the band of knobs
     * reaches for. */
    static uint16_t snare_notes[MP7_USER_PATTERN_COLUMNS];
    static int16_t snare[20480];
    static int16_t muted[20480];
    static int16_t dark[20480];

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        snare_notes[column] = (uint16_t)(1u << 1);
    }

    prepare_pattern(ctx, 9, snare_notes);
    render(ctx, snare, 20480);
    check(peak(snare, 20480) > 0, "the snare is heard");

    prepare_pattern(ctx, 9, snare_notes);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_VOLUME, 0) == 1,
          "the level of a voice can be moved");
    render(ctx, muted, 20480);
    check(peak(muted, 20480) == 0, "a voice at level zero is silent");

    prepare_pattern(ctx, 9, snare_notes);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_CUTOFF, 800) == 1,
          "the cutoff of a voice can be moved");
    render(ctx, dark, 20480);
    check(memcmp(dark, snare, sizeof(snare)) != 0,
          "a lower cutoff changes the voice");

    prepare_pattern(ctx, 9, snare_notes);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_DECAY, 200000) == 1,
          "the decay of a voice can be moved");
    render(ctx, dark, 20480);
    check(memcmp(dark, snare, sizeof(snare)) != 0,
          "a shorter decay changes the voice");

    /* A value outside the range of the parameter, an instrument that does
     * not exist and a parameter that does not exist are all refused. */
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_CUTOFF, 0) == 0,
          "a cutoff below the range is refused");
    check(poppy_set_voice_param(ctx, 99, MP7_VOICE_CUTOFF, 5000) == 0,
          "an instrument that does not exist is refused");
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, 99, 5000) == 0,
          "a parameter that does not exist is refused");

    /* A knob that is turned while the voice is ringing does not make the
     * note click: the level fades into its new value, and the other
     * parameters wait for the next note of the voice. */
    static int16_t ringing[20480];
    static int16_t fading[1024];
    static int16_t faded[40960];

    prepare_pattern(ctx, 9, snare_notes);
    render(ctx, ringing, 20480);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_VOLUME, 0) == 1,
          "the level of a voice can be moved while it rings");
    render(ctx, fading, 1024);
    check(peak(fading, 1024) > 0,
          "a level that is moved while the voice rings fades out");

    render(ctx, faded, 40960);
    check(peak(faded + 38912, 2048) == 0,
          "the level of the voice reaches its target");

    /* A parameter that is not the level waits for the next note: the note
     * that is sounding keeps the settings it started with. */
    static int16_t before[2048];
    static int16_t after[2048];

    poppy_reset(ctx);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, before, 2048);

    poppy_reset(ctx);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_CUTOFF, 900) == 1,
          "the cutoff of a voice can be moved while it rings");
    render(ctx, after, 2048);
    check(memcmp(before, after, sizeof(before)) == 0,
          "a note that is sounding keeps its cutoff");

    poppy_reset(ctx);
    check(poppy_set_voice_param(ctx, MP7_INSTR_SNARE_1, MP7_VOICE_CUTOFF, 900) == 1,
          "the cutoff of a voice can be moved");
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, after, 2048);
    check(memcmp(before, after, sizeof(before)) != 0,
          "the next note of a voice takes the parameters that were moved");

    poppy_destroy(ctx);
    printf("%s\n",
           failures == 0 ? "all glue checks passed" : "there were failures");
    return failures == 0 ? 0 : 1;
}
