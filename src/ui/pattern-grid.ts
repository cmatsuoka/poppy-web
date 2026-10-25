/*
 * pattern-grid.ts - the printed pattern card and its playhead.
 *
 * The card is a read-only display of the factory pattern the engine is
 * playing. The note data comes from the engine: the worklet reads it with
 * `mp7_get_factory_pattern()` and the main thread combines the selected
 * rhythms the same way the C engine does when it merges a selection - the
 * note masks are OR-ed, the enable masks are AND-ed and the triplet flags
 * are OR-ed. The shared Tambourine/Guiro/Quijada layer belongs to every
 * rhythm, so it is added on top of the selection.
 *
 * The playhead follows the column the engine reports in its panel snapshots.
 * The card advances the cursor on its own clock, using the engine's timing
 * rules: a column lasts three sub-steps, four for the shuffle rhythms, and a
 * disabled column is skipped without taking any time. The cursor glides into
 * the next column just before the boundary, so it is already on the column
 * when the engine fires its hits.
 *
 * With `prefers-reduced-motion` the cursor jumps straight to the reported
 * column instead of gliding.
 */

import type { PoppyEngine } from '../audio/engine';
import {
  INSTRUMENT_NAMES,
  PATTERN_COLUMNS,
  RHYTHM_NAMES,
  type Bank,
  type PanelState,
  type PatternView,
} from '../audio/protocol';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLUMN_MASK = PATTERN_COLUMNS - 1;
const LABEL_WIDTH = 74;
const ROW_HEIGHT = 14;
const HIT_RADIUS = 3.1;
const PLAYHEAD_WIDTH = 2;
const ENABLE_ALL = (1n << BigInt(PATTERN_COLUMNS)) - 1n;
const FALLBACK_SAMPLE_RATE = 48000;
// The Tambourine, Guiro and Quijada are the three Additional Volume voices.
const PERCUSSION_INSTRUMENT = 12;
// The spoken summary stays within a reasonable length.
const MAX_SPOKEN_COLUMNS = 16;

interface CardPattern {
  rhythms: number[];
  notes: number[];
  enable: bigint;
  triplet: boolean;
  rows: number[];
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  node.setAttribute('class', className);
  return node;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number): number {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

/** The rhythms the panel buttons of a bank select. */
export function rhythmsFor(bank: Bank, buttons: number): number[] {
  const rhythms: number[] = [];
  for (let bit = 0; bit < 10; bit += 1) {
    if ((buttons & (1 << bit)) !== 0) {
      rhythms.push(bank * 10 + bit);
    }
  }
  return rhythms;
}

function sameRhythms(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class PatternGrid {
  readonly element: HTMLDivElement;

  private readonly engine: PoppyEngine;
  private readonly body: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly layer: SVGGElement;
  private readonly playhead: SVGRectElement;
  private readonly nameRow: HTMLSpanElement;
  private readonly metaRow: HTMLSpanElement;
  private readonly stateRow: HTMLParagraphElement;

  private readonly views = new Map<number, PatternView>();
  private readonly requested = new Set<number>();
  private percussion: number[] = [];
  private percussionPeriod = 0;

  private pattern: CardPattern | null = null;
  private applied: number[] = [];
  private pending: number[] = [];
  private bank: Bank = 0;

  private anchorColumn = 0;
  private anchorWall = 0;
  private anchored = false;
  private running = false;
  private frame = 0;
  private columnWidth = 0;
  private rowCount = 0;

  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private readonly resizeObserver: ResizeObserver;

  constructor(engine: PoppyEngine, host: HTMLElement) {
    this.engine = engine;

    this.element = document.createElement('div');
    this.element.className = 'pattern-card';

    const head = document.createElement('div');
    head.className = 'pattern-card-head';

    const title = document.createElement('span');
    title.className = 'pattern-card-title';
    title.textContent = 'Pattern Card';

    this.nameRow = document.createElement('span');
    this.nameRow.className = 'pattern-card-names';

    this.metaRow = document.createElement('span');
    this.metaRow.className = 'pattern-card-meta';

    head.append(title, this.nameRow, this.metaRow);

    this.body = document.createElement('div');
    this.body.className = 'pattern-card-body';

    this.svg = svgElement('svg', 'pattern-grid');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', 'Pattern display');
    this.layer = svgElement('g', 'pattern-layer');
    this.playhead = svgElement('rect', 'pattern-playhead');
    this.playhead.setAttribute('opacity', '0');
    this.svg.append(this.layer, this.playhead);
    this.body.append(this.svg);

    this.stateRow = document.createElement('p');
    this.stateRow.className = 'pattern-card-state';

    this.element.append(head, this.body, this.stateRow);
    host.append(this.element);

    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.body);

    this.render();
  }

  /** Fold a panel snapshot into the card. */
  update(state: PanelState): void {
    const applied = rhythmsFor(state.bank, state.buttons);
    const pending = state.pending
      ? rhythmsFor(state.pendingBank, state.pendingButtons)
      : [];

    this.bank = state.bank;

    if (!sameRhythms(applied, this.applied)) {
      this.applied = applied;
      this.requestViews(applied);
      this.rebuild();
    }

    if (!sameRhythms(pending, this.pending)) {
      this.pending = pending;
      this.renderNames();
    }

    if (this.running !== state.running) {
      this.running = state.running;
      this.anchored = false;
      this.setRunning(state.running);
    }

    // A new column means the playhead crossed a column boundary, so the
    // cursor starts its next column here.
    if (!this.anchored || state.column !== this.anchorColumn) {
      this.anchorColumn = state.column;
      this.anchorWall = performance.now();
      this.anchored = true;
    }

    // The cursor is moved here as well, so it is already on the new column
    // when the snapshot arrives and not only on the next animation frame.
    this.updatePlayhead();
    this.updateState();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  private requestViews(rhythms: number[]): void {
    for (const rhythm of rhythms) {
      if (this.requested.has(rhythm)) {
        continue;
      }
      this.requested.add(rhythm);
      void this.engine
        .getPattern(rhythm)
        .then((view) => {
          this.views.set(rhythm, view);
          if (view.percussion.length > 0) {
            this.percussion = view.percussion;
            this.percussionPeriod = view.percussionPeriod;
          }
          this.rebuild();
        })
        .catch((error: unknown) => {
          this.requested.delete(rhythm);
          this.stateRow.textContent =
            error instanceof Error ? error.message : String(error);
        });
    }
  }

  /** Merge the selected rhythms the way the engine merges them. */
  private buildPattern(): CardPattern | null {
    const views = this.applied
      .map((rhythm) => this.views.get(rhythm))
      .filter((view): view is PatternView => view !== undefined);

    if (views.length === 0 && this.percussion.length === 0) {
      return null;
    }

    const notes: number[] = new Array<number>(PATTERN_COLUMNS).fill(0);
    let enable = ENABLE_ALL;
    let triplet = false;

    for (const view of views) {
      const period = view.notesPeriod;
      if (period > 0) {
        for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
          notes[column] =
            (notes[column] ?? 0) | (view.notes[column & (period - 1)] ?? 0);
        }
      }
      const mask =
        (BigInt(view.enableHi >>> 0) << 32n) | BigInt(view.enableLo >>> 0);
      enable &= mask;
      triplet = triplet || view.triplet;
    }

    // The shared percussion layer plays with every rhythm.
    if (this.percussionPeriod > 0) {
      for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
        notes[column] =
          (notes[column] ?? 0) |
          (this.percussion[column & (this.percussionPeriod - 1)] ?? 0);
      }
    }

    const rows: number[] = [];
    for (let instrument = 0; instrument < INSTRUMENT_NAMES.length; instrument += 1) {
      const bit = 1 << instrument;
      if (notes.some((mask) => (mask & bit) !== 0)) {
        rows.push(instrument);
      }
    }

    return { rhythms: [...this.applied], notes, enable, triplet, rows };
  }

  private rebuild(): void {
    this.pattern = this.buildPattern();
    this.renderNames();
    this.render();
  }

  private renderNames(): void {
    this.nameRow.replaceChildren();

    for (const rhythm of this.applied) {
      const name = document.createElement('span');
      name.className =
        rhythm < 10
          ? 'pattern-name pattern-name--a'
          : 'pattern-name pattern-name--b';
      name.textContent = RHYTHM_NAMES[rhythm] ?? '';
      this.nameRow.append(name);
    }

    if (this.pending.length > 0) {
      const pending = document.createElement('span');
      pending.className = 'pattern-name pattern-name--pending';
      pending.title = 'Applied at the end of the current cycle';
      pending.textContent = `→ ${this.pending
        .map((rhythm) => RHYTHM_NAMES[rhythm] ?? '')
        .join(' + ')}`;
      this.nameRow.append(pending);
    }
  }

  private render(): void {
    const pattern = this.pattern;
    const width = Math.max(220, this.body.clientWidth);
    const gridWidth = Math.max(120, width - LABEL_WIDTH);
    const columnWidth = gridWidth / PATTERN_COLUMNS;
    const rows = pattern?.rows ?? [];
    const height = Math.max(ROW_HEIGHT, rows.length * ROW_HEIGHT);

    this.columnWidth = columnWidth;
    this.rowCount = rows.length;

    this.svg.setAttribute('width', String(Math.round(width)));
    this.svg.setAttribute('height', String(height));
    this.svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${height}`);

    this.layer.replaceChildren();

    if (pattern === null) {
      this.svg.setAttribute(
        'aria-label',
        'Pattern display: no rhythm selected yet.',
      );
      this.playhead.setAttribute('opacity', '0');
      this.updateMeta();
      this.updateState();
      return;
    }

    // The columns the engine skips take no time, so they are printed as
    // empty ground.
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      if (this.isEnabled(pattern, column)) {
        continue;
      }
      const off = svgElement('rect', 'pattern-grid-off');
      off.setAttribute('x', String(this.columnX(column)));
      off.setAttribute('y', '0');
      off.setAttribute('width', String(columnWidth + 0.5));
      off.setAttribute('height', String(height));
      this.layer.append(off);
    }

    // Faint guides every eight columns help the eye across the card.
    for (let column = 8; column < PATTERN_COLUMNS; column += 8) {
      const guide = svgElement('line', 'pattern-grid-guide');
      guide.setAttribute('x1', String(this.columnX(column)));
      guide.setAttribute('x2', String(this.columnX(column)));
      guide.setAttribute('y1', '0');
      guide.setAttribute('y2', String(height));
      this.layer.append(guide);
    }

    // A stronger rule wherever the enabled columns start a new run.
    for (let column = 1; column < PATTERN_COLUMNS; column += 1) {
      const previous = (column - 1) & COLUMN_MASK;
      if (!this.isEnabled(pattern, column) || this.isEnabled(pattern, previous)) {
        continue;
      }
      const rule = svgElement('line', 'pattern-grid-rule');
      rule.setAttribute('x1', String(this.columnX(column)));
      rule.setAttribute('x2', String(this.columnX(column)));
      rule.setAttribute('y1', '0');
      rule.setAttribute('y2', String(height));
      this.layer.append(rule);
    }

    rows.forEach((instrument, row) => {
      const centre = row * ROW_HEIGHT + ROW_HEIGHT / 2;

      const label = svgElement('text', 'pattern-grid-label');
      label.setAttribute('x', String(LABEL_WIDTH - 8));
      label.setAttribute('y', String(centre));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = INSTRUMENT_NAMES[instrument] ?? '';
      this.layer.append(label);

      const bit = 1 << instrument;
      for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
        // A disabled column is never played, so it holds no hit either.
        if (!this.isEnabled(pattern, column)) {
          continue;
        }
        if (((pattern.notes[column] ?? 0) & bit) === 0) {
          continue;
        }
        const hit = svgElement(
          'circle',
          instrument >= PERCUSSION_INSTRUMENT
            ? 'pattern-grid-hit pattern-grid-hit--perc'
            : 'pattern-grid-hit',
        );
        hit.setAttribute('cx', String(this.columnX(column) + columnWidth / 2));
        hit.setAttribute('cy', String(centre));
        hit.setAttribute('r', String(HIT_RADIUS));
        this.layer.append(hit);
      }
    });

    this.svg.setAttribute('aria-label', this.describe(pattern));
    this.updateMeta();
    this.updateState();
    this.updatePlayhead();
  }

  private describe(pattern: CardPattern): string {
    const names = pattern.rhythms
      .map((rhythm) => RHYTHM_NAMES[rhythm] ?? '')
      .filter((name) => name !== '');
    const title =
      names.length > 0 ? names.join(' plus ') : 'the percussion layer only';
    const parts: string[] = [];
    for (const instrument of pattern.rows) {
      const columns: number[] = [];
      const bit = 1 << instrument;
      for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
        if (!this.isEnabled(pattern, column)) {
          continue;
        }
        if (((pattern.notes[column] ?? 0) & bit) !== 0) {
          columns.push(column + 1);
        }
      }
      const spoken = columns
        .slice(0, MAX_SPOKEN_COLUMNS)
        .join(', ');
      const rest =
        columns.length > MAX_SPOKEN_COLUMNS ? ', and more' : '';
      parts.push(`${INSTRUMENT_NAMES[instrument] ?? ''} on ${spoken}${rest}`);
    }
    return `Pattern display for ${title}. ${parts.join('; ')}.`;
  }

  private updateMeta(): void {
    this.metaRow.replaceChildren();
    if (this.pattern === null) {
      return;
    }

    const bank = document.createElement('span');
    bank.className = 'pattern-bank';
    bank.textContent = this.bank === 1 ? 'B' : 'A';
    this.metaRow.append(bank);

    if (this.pattern.triplet) {
      const triplet = document.createElement('span');
      triplet.className = 'pattern-flag';
      triplet.textContent = 'TRIPLET';
      this.metaRow.append(triplet);
    }

    const cycle = document.createElement('span');
    cycle.className = 'pattern-flag';
    cycle.textContent = `${PATTERN_COLUMNS} COL`;
    this.metaRow.append(cycle);
  }

  private updateState(): void {
    let text: string;
    if (this.pattern === null) {
      text =
        this.applied.length === 0
          ? 'Select a rhythm to see its pattern.'
          : 'Reading the pattern…';
    } else {
      const instruments = this.pattern.rows.length;
      const rows = `${instruments} instrument${instruments === 1 ? '' : 's'}`;
      text = this.running ? `Running · ${rows}` : `Stopped · ${rows}`;
    }
    if (this.stateRow.textContent !== text) {
      this.stateRow.textContent = text;
    }
  }

  private columnX(column: number): number {
    return LABEL_WIDTH + column * this.columnWidth;
  }

  /** The centre of a column, where its hits are printed. */
  private columnCentre(column: number): number {
    return this.columnX(column) + this.columnWidth / 2;
  }

  private isEnabled(pattern: CardPattern, column: number): boolean {
    return ((pattern.enable >> BigInt(column)) & 1n) === 1n;
  }

  private nextEnabled(pattern: CardPattern, column: number): number {
    for (let offset = 1; offset <= PATTERN_COLUMNS; offset += 1) {
      const next = (column + offset) & COLUMN_MASK;
      if (this.isEnabled(pattern, next)) {
        return next;
      }
    }
    return column;
  }

  private enabledCount(pattern: CardPattern): number {
    let count = 0;
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      if (this.isEnabled(pattern, column)) {
        count += 1;
      }
    }
    return count;
  }

  /** The time a column lasts, following the engine's own rules. */
  private columnDuration(pattern: CardPattern): number {
    const tempo = Math.max(1, this.engine.tempo);
    const sampleRate =
      this.engine.sampleRate > 0 ? this.engine.sampleRate : FALLBACK_SAMPLE_RATE;
    const subSteps = pattern.triplet ? 4 : 3;
    // The engine computes round(2.5 * sample_rate / tempo) samples.
    const subStepSamples = Math.max(
      1,
      Math.floor((5 * sampleRate + tempo) / (2 * tempo)),
    );
    return (subSteps * subStepSamples) / sampleRate;
  }

  private setRunning(running: boolean): void {
    if (running && this.frame === 0) {
      this.frame = requestAnimationFrame(this.tick);
      return;
    }
    if (!running && this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.updatePlayhead();
    }
  }

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    this.updatePlayhead();
  };

  private updatePlayhead(): void {
    const pattern = this.pattern;
    if (!this.running || pattern === null || this.columnWidth <= 0) {
      this.playhead.setAttribute('opacity', '0');
      return;
    }

    const duration = this.columnDuration(pattern);
    // The audio clock of the context is only refreshed every few frames on
    // the main thread, so the cursor runs on the local clock and is only
    // reset when a snapshot tells it that the column moved.
    const elapsed = Math.max(0, (performance.now() - this.anchorWall) / 1000);
    const totalSteps = Math.floor(elapsed / duration);
    const since = elapsed - totalSteps * duration;

    const enabled = this.enabledCount(pattern);
    let current = this.anchorColumn;
    if (enabled > 0) {
      const walk = totalSteps % enabled;
      for (let step = 0; step < walk; step += 1) {
        current = this.nextEnabled(pattern, current);
      }
    }

    const next = this.nextEnabled(pattern, current);

    // The cursor glides into the next column just before the boundary, so
    // it already sits on the column when the engine fires its hits. A
    // column that is skipped because the engine disables it is not glided
    // over, and neither is the wrap of the cycle: the cursor jumps there
    // with the rest of the grid.
    let lead = 0;
    if (!this.reducedMotion.matches && next === current + 1) {
      const transition = Math.min(0.25 * duration, 0.02);
      lead = smoothstep((since - (duration - transition)) / transition);
    }

    const x =
      this.columnCentre(current) +
      (this.columnCentre(next) - this.columnCentre(current)) * lead;

    this.playhead.setAttribute('x', String(x - PLAYHEAD_WIDTH / 2));
    this.playhead.setAttribute('y', '0');
    this.playhead.setAttribute('width', String(PLAYHEAD_WIDTH));
    this.playhead.setAttribute('height', String(this.rowCount * ROW_HEIGHT));
    this.playhead.setAttribute('opacity', '1');
  }
}
