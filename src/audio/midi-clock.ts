/*
 * midi-clock.ts - the external MIDI clock that drives the steps of the
 * machine.
 *
 * A clock source sends timing clock pulses (0xf8) at 24 pulses per
 * quarter note. Every accepted pulse is handed to the engine, which
 * advances the pattern one step at every third pulse (the straight grid
 * holds 8 columns to the quarter note) or fourth (the compound grid holds
 * six). The pattern position is a count of received pulses, so a follower
 * built that way cannot drift against the clock.
 */

/** The clock pulses MIDI counts on a quarter note. */
const PULSES_PER_QUARTER = 24;

/** How much of a fresh interval the tempo estimate of the print takes in. */
const BPM_EMA = 0.2;

/** The tempo of a MIDI clock, for the print of the readout. */
export interface MidiTempo {
  /** Microseconds per quarter note: 500000 is 120 BPM. */
  usPerQuarter: number;
  /** The same tempo in beats per minute, for the print. */
  bpm: number;
}

export interface MidiClockSyncOptions {
  /** A timing clock pulse of the followed input has arrived. */
  onPulse: () => void;
  /** The tempo of the clock, for the print. Nothing plays at it. */
  onTempo: (tempo: MidiTempo) => void;
  /** A start (0xfa) or a continue (0xfb): the transport is asked to play. */
  onStart: () => void;
  /** A stop (0xfc): the transport is asked to stop. */
  onStop: () => void;
}

/**
 * The external MIDI clock.
 *
 * While it is on, every input the browser offers is listened to, and the
 * inputs that are plugged in later join in: the `statechange` of the
 * access object attaches them as they come.
 */
export class MidiClockSync {
  private readonly onPulse: () => void;
  private readonly onTempo: (tempo: MidiTempo) => void;
  private readonly onStart: () => void;
  private readonly onStop: () => void;
  private access: MIDIAccess | null = null;
  private listening = new Set<MIDIInput>();
  private enabledState = false;
  /**
   * The clock hands out no usable timestamps, and the arrival time stands
   * in for them from the first unusable one on: the two kinds of time are
   * never mixed in one estimate, so the estimate is rebuilt as the clock
   * switches.
   */
  private byArrival = false;
  /**
   * The input the machine follows. The first input that sends a pulse
   * becomes the clock input; the pulses of the other inputs are left
   * unread, so a mirrored clock cannot count twice and two leaders are
   * not mixed. An input whose pulses stopped no longer holds the clock,
   * so a paused leader hands the following over to the live one. The
   * transport messages are still read from every input.
   */
  private clockInput: MIDIInput | null = null;
  /** The last pulse each input sent, for the quiet-clock check. */
  private readonly inputPulseSeen = new Map<MIDIInput, number>();
  /** How long an input stays the clock input after its last pulse. */
  private static readonly CLOCK_IDLE_MS = 2000;
  /** The wall time of the last accepted pulse, behind the print. */
  private lastPulse = -1;
  /** The estimate of a quarter note, in seconds, behind the print. */
  private quarterSeconds: number | null = null;
  /** The tempo last handed to the print, so a steady clock prints once. */
  private sent = -1;

  constructor(options: MidiClockSyncOptions) {
    this.onPulse = options.onPulse;
    this.onTempo = options.onTempo;
    this.onStart = options.onStart;
    this.onStop = options.onStop;
  }

  /** Whether the clock is being followed. */
  get enabled(): boolean {
    return this.enabledState;
  }

  /**
   * Ask the browser for the MIDI access and listen to every input.
   *
   * The promise resolves with the number of inputs joined: a zero means
   * the sync is on, but no machine is sending anything to it yet.
   */
  async enable(): Promise<number> {
    const request = navigator.requestMIDIAccess;
    if (typeof request !== 'function') {
      throw new Error('this browser does not offer Web MIDI');
    }

    const access = await request.call(navigator, { sysex: false });
    this.access = access;
    this.enabledState = true;
    this.reset();

    access.onstatechange = () => this.refreshInputs();
    this.refreshInputs();
    return this.listening.size;
  }

  /** Stop following the clock and drop the access. */
  disable(): void {
    this.enabledState = false;
    for (const input of this.listening) {
      input.onmidimessage = null;
    }
    this.listening.clear();
    this.access = null;
    this.reset();
  }


  /**
   * Join every input that is connected and drop every one that left.
   *
   * It runs when the sync comes on and whenever the browser reports a
   * machine arriving or leaving.
   */
  private refreshInputs(): void {
    const access = this.access;
    if (!this.enabledState || access === null) {
      return;
    }

    access.inputs.forEach((input) => {
      if (input.state !== 'connected') {
        return;
      }
      if (this.listening.has(input)) {
        return;
      }
      // The input is subscribed to, not opened: the ports of Web MIDI are
      // shared and carry no exclusive mode, so the machine sending to the
      // browser keeps sending to everything else as well. Subscribing is
      // all a reader needs - the port goes open on its first message.
      input.onmidimessage = this.onMessage;
      this.listening.add(input);
    });

    for (const input of this.listening) {
      if (input.state === 'disconnected' || !access.inputs.has(input.id)) {
        input.onmidimessage = null;
        this.listening.delete(input);
        if (this.clockInput === input) {
          // The clock input left: the next pulse latches a fresh one.
          this.clockInput = null;
        }
      }
    }
  }

  private readonly onMessage = (event: MIDIMessageEvent): void => {
    const data = event.data;
    // The transport and the pulses are carried by single status bytes;
    // everything else - channel notes, song position, system data - is
    // left alone.
    if (data === null || data.length !== 1) {
      return;
    }

    switch (data[0] ?? 0) {
      case 0xf8:
        this.readPulse(event, event.target as MIDIInput | null);
        return;
      case 0xfa: // start
      case 0xfb: // continue
        this.onStart();
        return;
      case 0xfc: // stop
        this.onStop();
        return;
    }
  };

  /** Follow this input from now on: its pulses drive the machine. */
  private latchInput(input: MIDIInput): void {
    this.clockInput = input;
  }

  /** One timing clock pulse: a twenty-fourth of a quarter note. */
  private readPulse(event: MIDIMessageEvent, input: MIDIInput | null): void {
    const stamp = event.timeStamp;
    let time = stamp;
    if (!Number.isFinite(time) || time <= 0) {
      // No usable timestamp: read by arrival, and rebuild the estimate so
      // a clock that changes its mind is never read across the switch.
      if (!this.byArrival) {
        this.byArrival = true;
        this.quarterSeconds = null;
        this.lastPulse = -1;
      }
      time = performance.now();
    }

    // The clock is followed on one input: the first input that sends a
    // pulse latches it, and the pulses of the other inputs are left
    // unread - a mirrored clock cannot count twice and two leaders are
    // not mixed. An input whose pulses stopped no longer holds the
    // clock, so a paused leader hands the following over to the live
    // one. Every pulse the latched input carries counts, whatever the
    // delivery does with its stamps.
    const previous = this.lastPulse;
    if (input !== null) {
      // The freshness of every input is tracked, so the check below can
      // tell a live clock from a quiet one.
      this.inputPulseSeen.set(input, time);
      const latched = this.clockInput;
      if (
        latched === null ||
        (input !== latched &&
          time - (this.inputPulseSeen.get(latched) ?? -Infinity) >
            MidiClockSync.CLOCK_IDLE_MS)
      ) {
        this.latchInput(input);
      } else if (input !== latched) {
        return;
      }
    }

    this.lastPulse = time;
    this.onPulse();

    // The estimate behind the print: the interval between two pulses, on
    // the clock of their stamps (or of the arrival, when the stamps are
    // unusable). A print made on this clock plays nothing at it - the
    // machine is driven by the pulses - so the wander of the driver's
    // stamps only reaches what the readout shows.
    const interval = previous >= 0 ? time - previous : null;
    const bpm = this.bpmOf(interval);
    if (bpm !== null) {
      const usPerQuarter = Math.round(60000000 / bpm);
      if (usPerQuarter !== this.sent) {
        this.sent = usPerQuarter;
        this.onTempo({ usPerQuarter, bpm });
      }
    } else {
      this.onTempoMissing();
    }
  }

  /** Smooth the interval of a pulse into the bpm of the print. */
  private bpmOf(interval: number | null): number | null {
    if (interval === null || interval <= 0) {
      return null;
    }
    // A quarter note is PULSES_PER_QUARTER of these: the interval is the
    // length of one pulse, in milliseconds.
    const quarter = (interval / 1000) * PULSES_PER_QUARTER;
    // Outside a beat of thirty to two thousand a minute a clock is not
    // saying anything this follower can use - a pause of the clock
    // arrives here as one absurd interval and is let go.
    if (quarter < 0.03 || quarter > 2.0) {
      return null;
    }
    this.quarterSeconds =
      this.quarterSeconds === null
        ? quarter
        : this.quarterSeconds + (quarter - this.quarterSeconds) * BPM_EMA;
    return 60 / this.quarterSeconds;
  }

  /**
   * The clock has not said its tempo yet, or has dropped out of the range
   * the estimate can carry: the readout goes back to where the tempo
   * comes from.
   */
  private onTempoMissing(): void {
    if (this.sent !== -1) {
      this.sent = -1;
      this.quarterSeconds = null;
      this.onTempo({ usPerQuarter: 0, bpm: 0 });
    }
  }

  private reset(): void {
    this.byArrival = false;
    this.clockInput = null;
    this.inputPulseSeen.clear();
    this.lastPulse = -1;
    this.quarterSeconds = null;
    this.sent = -1;
  }
}
