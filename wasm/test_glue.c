/*
 * test_glue.c - a native check for wasm/poppy_wasm.c.
 *
 * The glue is Emscripten code, but it is plain C: the stub
 * emscripten/emscripten.h lets it be compiled with the host compiler
 * against the same library sources the wasm build uses. The check covers
 * the parts the panel depends on: the user slots the engine starts with,
 * the source switch, the round trip through a user slot, the accent flag
 * of a column and the settings the band of knobs reaches for.
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

/* The loudest sample of one channel of a rendered block. The samples are
 * interleaved, so the two channels follow each other. */
static int channel_peak(const int16_t *samples, int count, int channel)
{
    int loudest = 0;

    for (int i = 0; i < count / 2; i++) {
        int value = samples[2 * i + channel];

        if (value < 0) {
            value = -value;
        }
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
    poppy_set_user_pattern(ctx, slot, (int32_t)(uintptr_t)notes,
                            MP7_TIMESIG_4_4);
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

    /* The user slots of the engine come up empty: the panel writes the
     * rhythms of the two banks into them. */
    struct mp7_user_pattern empty;
    check(mp7_get_user_pattern(ctx, 0, &empty) == 0,
          "the user slots come up empty");

    /* The view of a selection carries the whole cycle: the period a rhythm
     * is stored in is repeated out to the 64 columns of the cycle before
     * the panel sees it, and the shared percussion layer is merged into it
     * in the preset source. */
    int32_t *factory = poppy_selection_pattern(ctx, 0, 1 << 6);
    check(factory[5] == 1, "the view of a selection is valid");
    check(factory[6] == (int32_t)MP7_PATTERN_COLUMNS,
          "the view of a selection is a whole cycle long");

    /* The grid of the view is the grid the engine holds, column for
     * column, so the panel sees the whole cycle. */
    struct mp7_pattern_view raw;
    mp7_get_selection_pattern(ctx, MP7_BANK_A,
                               mp7_rhythm_button_bit((mp7_rhythm)6), &raw);
    uint16_t *factory_notes = (uint16_t *)(uintptr_t)factory[0];
    int same = 1;
    for (int column = 0; column < (int)MP7_PATTERN_COLUMNS; column++) {
        if (factory_notes[column] != raw.notes[column]) {
            same = 0;
        }
    }
    check(same, "the grid of a view is the grid of the engine");

    /* The view of a selection is the composition the engine plays: the
     * notes of the rhythms that are combined are OR-ed together and the
     * masks are AND-ed. */
    int32_t *selection = poppy_selection_pattern(ctx, 0, (1 << 6) | (1 << 0));
    check(selection[5] == 1, "the view of a selection is valid");
    check(selection[6] == (int32_t)MP7_PATTERN_COLUMNS,
          "the view of a selection is a whole cycle long");
    check(selection[3] == -1,
          "a selection of different meters carries no meter");
    check(selection[4] == 0,
          "a selection of two straight rhythms is on the straight grid");

    int32_t *single = poppy_selection_pattern(ctx, 0, 1 << 6);
    check(single[3] == MP7_TIMESIG_4_4,
          "a selection of one rhythm carries its meter");

    /* The row of the 5/4 meter: the mask the engine holds for it is the
     * row the rhythms of the panel were written on.
     *
     *   xxxxxx--xxxxxx--xxxx----xxxx----xxxxxx--xxxxxx--xxxx----xxxx----
     *
     * The bar is five beats long, and the runs of the row are the cells of
     * the groove. */
    check(mp7_timesig_enable_mask(MP7_TIMESIG_5_4T) ==
              UINT64_C(0x0F0F3F3F0F0F3F3F),
          "the 5/4 meter plays the row of the panel");
    check(mp7_timesig_enable_mask(MP7_TIMESIG_6_8T) ==
              mp7_timesig_enable_mask(MP7_TIMESIG_2_4),
          "the 6/8 meter plays on the compound grid");

    /* The user source plays the rhythm of the slot, the preset source
     * plays the factory rhythm. */
    static int16_t preset[20480];
    static int16_t user[20480];
    static uint16_t bass_notes[MP7_USER_PATTERN_COLUMNS];

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        bass_notes[column] = (uint16_t)((column % 8) == 0 ? (1u << 0) : 0);
    }

    poppy_reset(ctx);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, preset + i * 512 * 2, 512);
    }

    poppy_reset(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)bass_notes,
                            MP7_TIMESIG_4_4);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, user + i * 512 * 2, 512);
    }

    check(peak(preset, 20480) > 0, "the preset source plays the factory rhythm");
    check(peak(user, 20480) > 0, "the user source plays the rhythm of the slot");

    /* A pattern the user wrote survives a reset: the reset puts the voices
     * and the mix controls back, not the work of the user. */
    poppy_reset(ctx);
    struct mp7_user_pattern kept;
    check(mp7_get_user_pattern(ctx, 6, &kept),
          "the pattern of a slot survives a reset");
    check(memcmp(kept.notes, bass_notes, sizeof(bass_notes)) == 0,
          "the pattern of a slot is unchanged by a reset");

    /* A written pattern comes back as it was written. */
    static uint16_t notes[MP7_USER_PATTERN_COLUMNS];
    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)((column % 8) == 0 ? (1u << 0) : 0);
    }

    check(poppy_set_user_pattern(ctx, 3, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_4_4) == 1,
          "a pattern is written into a slot");

    struct mp7_user_pattern read;
    check(mp7_get_user_pattern(ctx, 3, &read), "the slot can be read back");
    check(memcmp(read.notes, notes, sizeof(notes)) == 0,
          "the notes come back unchanged");
    check(read.timesig == MP7_TIMESIG_4_4, "the time signature comes back unchanged");
    check(poppy_set_user_pattern(ctx, 99, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_4_4) == 0,
          "a slot out of range is refused");
    check(poppy_set_user_pattern(ctx, 99, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_COUNT) == 0,
          "a time signature the engine does not know is refused");

    /* The meter of a pattern: the pattern names its time signature and the
     * engine derives the mask of the steps it plays from it. The mask comes
     * back in the view of the slot, and the sequencer never visits a step
     * the mask leaves out. */
    check(poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_3_4) == 1,
          "a pattern with a meter is written into a slot");
    check(mp7_get_user_pattern(ctx, 6, &read), "the slot with a meter is read");
    check(read.timesig == MP7_TIMESIG_3_4, "the meter comes back unchanged");

    int32_t *metered = poppy_user_pattern(ctx, 6);
    check(metered[1] == MP7_TIMESIG_3_4,
          "the slot carries the meter");
    check(metered[2] == 1, "the slot is not empty");

    /* The mask of the meter and the grid it plays on come with the view of
     * the selection the slot is in. The user source is the one the slot
     * belongs to, so the view is the one of the slot. */
    poppy_set_pattern_source(ctx, 1);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    int32_t *metered_view = poppy_selection_pattern(ctx, 0, 1 << 6);
    check((metered_view[1] != 0) || (metered_view[2] != 0),
          "the view of the selection carries the mask of the meter");
    check(metered_view[3] == MP7_TIMESIG_3_4,
          "the view of the selection carries the meter");
    check(metered_view[4] == 0, "the 3/4 meter plays on the straight grid");

    static int16_t masked[307200];
    int skipped = 0;
    uint64_t metered_mask = mp7_timesig_enable_mask(MP7_TIMESIG_3_4);

    poppy_reset(ctx);
    poppy_set_pattern_source(ctx, 1);
    poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes, MP7_TIMESIG_3_4);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    /* The cycle of the meter is 48 columns long, so the render has to be
     * long enough to walk over all of them. */
    for (int i = 0; i < 300; i++) {
        poppy_process(ctx, masked + i * 512 * 2, 512);
        int column = poppy_panel_state(ctx)[6];
        if (((metered_mask >> column) & 1u) == 0u) {
            skipped = 1;
        }
    }
    check(skipped == 0, "the sequencer never visits a skipped step");

    /* The 2/4 and the 6/8 share the compound grid: a beat holds six
     * columns there, and the view of the pattern says so. */
    check(poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_2_4) == 1,
          "a pattern in 2/4 is written into a slot");
    poppy_set_pattern_source(ctx, 1);
    poppy_select_rhythm(ctx, 0, 1 << 6);
    int32_t *compound = poppy_selection_pattern(ctx, 0, 1 << 6);
    check(compound[4] == 1, "the 2/4 meter plays on the compound grid");
    check(poppy_set_user_pattern(ctx, 6, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_6_8T) == 1,
          "a pattern in 6/8 is written into a slot");
    compound = poppy_selection_pattern(ctx, 0, 1 << 6);
    check(compound[4] == 1, "the 6/8 meter plays on the compound grid");

    /* An accented column comes back as it was written, accent flag and all. */
    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)(((column % 8) == 0 ? (1u << 0) : 0) |
                                    MP7_PATTERN_ACCENT);
    }
    check(poppy_set_user_pattern(ctx, 4, (int32_t)(uintptr_t)notes,
                                 MP7_TIMESIG_4_4) == 1,
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
    poppy_set_user_pattern(ctx, 5, (int32_t)(uintptr_t)notes, MP7_TIMESIG_4_4);
    poppy_select_rhythm(ctx, 0, 1 << 5);
    for (int i = 0; i < 20; i++) {
        poppy_process(ctx, plain + i * 512 * 2, 512);
    }

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        notes[column] = (uint16_t)((1u << 0) | MP7_PATTERN_ACCENT);
    }
    poppy_set_user_pattern(ctx, 5, (int32_t)(uintptr_t)notes, MP7_TIMESIG_4_4);
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

    /* The settings the band of knobs reaches for: the level of the snare,
     * the decay and the center of its band-pass, the center of the
     * band-pass of the hi-hat and the place of a voice in the stereo
     * field. */
    static uint16_t snare_notes[MP7_USER_PATTERN_COLUMNS];
    static int16_t snare[20480];
    static int16_t muted[20480];
    static int16_t dark[20480];
    static int16_t bright[20480];

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        snare_notes[column] = (uint16_t)(1u << 1);
    }

    prepare_pattern(ctx, 9, snare_notes);
    render(ctx, snare, 20480);
    check(peak(snare, 20480) > 0, "the snare is heard");

    /* A voice can be played louder than the level it comes up with: the
     * level knobs of the band go up to twice that level. */
    static int16_t loud[20480];

    prepare_pattern(ctx, 9, snare_notes);
    poppy_set_instr_gain(ctx, MP7_INSTR_SNARE_1, 2 * 65536);
    render(ctx, loud, 20480);
    check(peak(loud, 20480) > peak(snare, 20480),
          "a voice at twice its level is louder");
    poppy_set_instr_gain(ctx, MP7_INSTR_SNARE_1, 65536);

    prepare_pattern(ctx, 9, snare_notes);
    poppy_set_instr_gain(ctx, MP7_INSTR_SNARE_1, 0);
    render(ctx, muted, 20480);
    check(peak(muted, 20480) == 0, "a voice at level zero is silent");

    prepare_pattern(ctx, 9, snare_notes);
    poppy_set_snare1_cutoff(ctx, 1000);
    render(ctx, dark, 20480);
    check(memcmp(dark, snare, sizeof(snare)) != 0,
          "a lower cutoff changes the voice");

    prepare_pattern(ctx, 9, snare_notes);
    poppy_set_snare1_decay(ctx, 65536 / 4);
    render(ctx, dark, 20480);
    check(memcmp(dark, snare, sizeof(snare)) != 0,
          "a shorter decay changes the voice");

    static uint16_t hihat_notes[MP7_USER_PATTERN_COLUMNS];
    static int16_t hihat[20480];

    for (int column = 0; column < MP7_USER_PATTERN_COLUMNS; column++) {
        hihat_notes[column] = (uint16_t)((column % 8) == 0
                                         ? (1u << MP7_INSTR_HIHAT)
                                         : 0);
    }

    prepare_pattern(ctx, 9, hihat_notes);
    render(ctx, hihat, 20480);
    check(peak(hihat, 20480) > 0, "the hi-hat is heard");

    prepare_pattern(ctx, 9, hihat_notes);
    poppy_set_hihat_cutoff(ctx, 15000);
    render(ctx, bright, 20480);
    check(memcmp(bright, hihat, sizeof(hihat)) != 0,
          "a higher cutoff of the hi-hat changes the voice");

    /* A value outside the range of a parameter is clamped by the engine,
     * and an instrument that does not exist is ignored. */
    poppy_set_snare1_cutoff(ctx, 0);
    poppy_set_hihat_cutoff(ctx, 0);
    poppy_set_instr_gain(ctx, 99, 0);
    poppy_set_instr_pan(ctx, 99, 0);

    /* The settings of the band of knobs survive a sample-rate change: the
     * engine builds the voices again and puts the settings back with
     * them. */
    static int16_t factory_cutoff[20480];
    static int16_t moved_cutoff[20480];

    prepare_pattern(ctx, 9, snare_notes);
    mp7_set_sample_rate(ctx, 22050);
    render(ctx, factory_cutoff, 20480);

    prepare_pattern(ctx, 9, snare_notes);
    poppy_set_snare1_cutoff(ctx, 1000);
    mp7_set_sample_rate(ctx, 22050);
    render(ctx, moved_cutoff, 20480);

    check(memcmp(moved_cutoff, factory_cutoff, sizeof(moved_cutoff)) != 0,
          "the settings of a voice survive a sample-rate change");
    mp7_set_sample_rate(ctx, 44100);

    /* The place of a voice in the stereo field. The pan is a place
     * between the two channels: a voice that is panned hard to one side
     * is louder in that channel, and a voice in the center is the same
     * in both. */
    static int16_t panned[4096];
    static int16_t centered[4096];

    poppy_reset(ctx);
    poppy_set_instr_pan(ctx, MP7_INSTR_SNARE_1, 65536);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, panned, 4096);
    check(channel_peak(panned, 4096, 1) > channel_peak(panned, 4096, 0),
          "a voice panned hard right is louder in the right channel");

    poppy_reset(ctx);
    poppy_set_instr_pan(ctx, MP7_INSTR_SNARE_1, 0);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, panned, 4096);
    check(channel_peak(panned, 4096, 0) > channel_peak(panned, 4096, 1),
          "a voice panned hard left is louder in the left channel");

    poppy_reset(ctx);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, centered, 4096);
    check(channel_peak(centered, 4096, 0) == channel_peak(centered, 4096, 1),
          "a voice in the center of the field is the same in both channels");

    /* A pan outside the range of the parameter is clamped by the engine. */
    poppy_reset(ctx);
    poppy_set_instr_pan(ctx, MP7_INSTR_SNARE_1, 65537);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, panned, 4096);
    check(channel_peak(panned, 4096, 1) > channel_peak(panned, 4096, 0),
          "a pan above the range is clamped to the right");

    /* The pan is taken at once, also by a note that is already sounding. */
    static int16_t before[2048];
    static int16_t after[2048];

    poppy_reset(ctx);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    render(ctx, before, 2048);

    poppy_reset(ctx);
    poppy_trigger(ctx, MP7_INSTR_SNARE_1, 127);
    poppy_set_instr_pan(ctx, MP7_INSTR_SNARE_1, 65536);
    render(ctx, after, 2048);
    check(memcmp(before, after, sizeof(before)) != 0,
          "a note that is sounding takes the pan that was moved");

    poppy_destroy(ctx);
    printf("%s\n",
           failures == 0 ? "all glue checks passed" : "there were failures");
    return failures == 0 ? 0 : 1;
}
