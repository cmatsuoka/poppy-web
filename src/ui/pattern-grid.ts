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
 *
 * The Guiro row is printed differently from the other rows. The Guiro is
 * the only gated voice: the machine holds it open while the gate is on,
 * so a run of hits is one continuous roll and not a row of separate
 * notes. A run is therefore drawn as a bar with a dot at each end.
 *
 * The extended mode turns the card into an editor of the user patterns:
 * the name of the pattern is written on the card, and the accent row at the
 * bottom of the grid marks the steps the engine plays louder. The accent
 * row is drawn in red, the colour of the bank B names.
 */

import type { PoppyEngine } from '../audio/engine';
import {
  INSTRUMENT_NAMES,
  PATTERN_ACCENT_BIT,
  PATTERN_COLUMNS,
  PATTERN_SOURCE_USER,
  PATTERN_STEPS_PER_BAR,
  RHYTHM_NAMES,
  type Bank,
  type PanelState,
  type PatternSource,
  type PatternView,
} from '../audio/protocol';
import { MAX_NAME_LENGTH, type UserNames } from './user-names';

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
// The Guiro is the gated voice: it is held open for as long as the gate
// is on.
const GUIRO_INSTRUMENT = 13;
// The spoken summary stays within a reasonable length.
const MAX_SPOKEN_COLUMNS = 16;

interface CardPattern {
  rhythms: number[];
  notes: number[];
  enable: bigint;
  triplet: boolean;
  /** The instruments the card prints: the ones that play, or all of them. */
  rows: number[];
  /** The instruments that play. */
  voices: number[];
  /** The steps the engine plays louder. */
  accents: boolean[];
}

/** What the card needs from the panel that owns it. */
export interface PatternGridOptions {
  /** The names of the user patterns. */
  names: UserNames;
  /**
   * Called when a step of the accent row is clicked or keyed. The panel
   * writes the accent into the user patterns it shows.
   */
  onAccent?: (column: number, accent: boolean) => void;
  /**
   * Called when a voice is put into a step of the grid, or taken out again.
   */
  onToggle?: (instrument: number, column: number, on: boolean) => void;
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
  private readonly cursorLayer: SVGGElement;
  private readonly cursor: SVGRectElement;
  private readonly playhead: SVGRectElement;
  private readonly nameRow: HTMLSpanElement;
  private readonly metaRow: HTMLSpanElement;
  private readonly stateRow: HTMLParagraphElement;
  private readonly description: HTMLParagraphElement;
  /** The control that opens the card to the voices that are still empty. */
  private readonly expandButton: HTMLButtonElement;

  private readonly names: UserNames;
  private readonly onAccent: ((column: number, accent: boolean) => void) | null;
  private readonly onToggle:
    | ((instrument: number, column: number, on: boolean) => void)
    | null;
  private readonly stopWatchingNames: () => void;

  private readonly views = new Map<number, PatternView>();
  private readonly requested = new Set<number>();
  private percussion: number[] = [];
  private percussionPeriod = 0;

  private pattern: CardPattern | null = null;
  private applied: number[] = [];
  private pending: number[] = [];
  private bank: Bank = 0;
  private source: PatternSource = 0;
  /**
   * The row of the grid the keyboard is on and the step it points at.
   *
   * The last row of the grid is the accent row, so the cursor reaches the
   * accents as well.
   */
  private cursorRow = 0;
  private cursorColumn = 0;

  /** The names the card prints, and the field that is being written in. */
  private nameNodes: Array<{ rhythm: number; node: HTMLElement }> = [];
  private pendingNode: HTMLSpanElement | null = null;
  private nameSignature = '';

  /**
   * Whether the card prints the voices that are still empty.
   *
   * A pattern that plays two voices is two rows on the card, and that is
   * the compact print of a pattern. The open card prints all the voices,
   * the empty ones included, so the user can see what is left to write.
   * Only a user pattern can be written, so a factory rhythm stays the
   * compact print.
   */
  private expanded = false;

  private showsAllVoices(): boolean {
    return this.expanded && this.source === PATTERN_SOURCE_USER;
  }

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

  constructor(
    engine: PoppyEngine,
    host: HTMLElement,
    options: PatternGridOptions,
  ) {
    this.engine = engine;
    this.names = options.names;
    this.onAccent = options.onAccent ?? null;
    this.onToggle = options.onToggle ?? null;

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
    this.cursorLayer = svgElement('g', 'pattern-cursor-layer');
    this.cursor = svgElement('rect', 'pattern-grid-cursor');
    this.cursorLayer.append(this.cursor);
    this.playhead = svgElement('rect', 'pattern-playhead');
    this.playhead.setAttribute('opacity', '0');
    this.playhead.setAttribute('aria-hidden', 'true');
    this.svg.append(this.layer, this.cursorLayer, this.playhead);
    this.body.append(this.svg);

    this.stateRow = document.createElement('p');
    this.stateRow.className = 'pattern-card-state';

    // The control that opens the card. It belongs to the extended mode:
    // a factory rhythm is a print, and there is nothing to add to it.
    this.expandButton = document.createElement('button');
    this.expandButton.className = 'pattern-card-expand';
    this.expandButton.type = 'button';
    this.expandButton.setAttribute('aria-pressed', 'false');
    this.expandButton.textContent = 'All voices';
    this.expandButton.title =
      'Print the voices that are still empty, so you can see what is left to write';
    this.expandButton.addEventListener('click', () => {
      // The cursor keeps its voice when the card opens or closes.
      const voice = this.pattern?.rows[this.cursorRow];
      this.expanded = !this.expanded;
      this.expandButton.setAttribute(
        'aria-pressed',
        this.expanded ? 'true' : 'false',
      );
      this.rebuild();
      const rows = this.pattern?.rows ?? [];
      const index = voice === undefined ? -1 : rows.indexOf(voice);
      if (index >= 0) {
        this.cursorRow = index;
        this.render();
      }
    });
    // The control does not take the focus away from the grid, so the
    // keyboard can go on writing where it was.
    this.expandButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    const foot = document.createElement('div');
    foot.className = 'pattern-card-foot';
    foot.append(this.stateRow, this.expandButton);

    // The spoken description of the pattern. In the extended mode the grid
    // itself carries the accent row, which a screen reader has to reach,
    // so the drawing is hidden and the description is read out instead.
    this.description = document.createElement('p');
    this.description.className = 'visually-hidden';
    this.description.id = 'pattern-card-description';

    this.element.append(head, this.body, foot, this.description);
    host.append(this.element);

    // The grid is a switchboard in the extended mode: a click puts a voice
    // into a step, and the keyboard walks over the grid.
    this.svg.addEventListener('click', (event) => this.onGridClick(event));
    this.svg.addEventListener('keydown', (event) => this.onGridKeyDown(event));

    // A name that is changed on the card is printed on the key bed, and a
    // name that is changed elsewhere belongs on the card as well.
    this.stopWatchingNames = this.names.onChange(() => this.renderNames());

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

    const bankChanged = this.bank !== state.bank;
    this.bank = state.bank;

    // The card shows the patterns of the source the machine plays. When the
    // source changes, the patterns it holds are the ones of the other set.
    if (this.source !== state.source) {
      this.source = state.source;
      this.invalidate();
    }

    if (!sameRhythms(applied, this.applied)) {
      this.applied = applied;
      this.requestViews(applied);
      this.rebuild();
    } else if (bankChanged) {
      this.updateMeta();
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
    this.stopWatchingNames();
    if (this.frame !== 0) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  /**
   * Forget the patterns the card holds and read them again.
   *
   * A user pattern that was written, and a change of the source, both make
   * the patterns the card shows out of date.
   */
  invalidate(): void {
    this.views.clear();
    this.requested.clear();
    // The shared percussion layer belongs to the factory rhythms only: a
    // user pattern carries its own percussion lines.
    this.percussion = [];
    this.percussionPeriod = 0;
    this.requestViews(this.applied);
    this.rebuild();
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
    const accents: boolean[] = new Array<boolean>(PATTERN_COLUMNS).fill(false);
    let enable = ENABLE_ALL;
    let triplet = false;

    for (const view of views) {
      const period = view.notesPeriod;
      if (period > 0) {
        for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
          const noteMask = view.notes[column & (period - 1)] ?? 0;
          notes[column] = (notes[column] ?? 0) | noteMask;
          // The accent flag rides in the highest bit of the column.
          if ((noteMask & PATTERN_ACCENT_BIT) !== 0) {
            accents[column] = true;
          }
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

    const voices: number[] = [];
    for (let instrument = 0; instrument < INSTRUMENT_NAMES.length; instrument += 1) {
      const bit = 1 << instrument;
      if (notes.some((mask) => (mask & bit) !== 0)) {
        voices.push(instrument);
      }
    }

    // The open card prints the voices that are still empty as well, so the
    // user can see what is left to write.
    const rows = this.showsAllVoices()
      ? INSTRUMENT_NAMES.map((_, instrument) => instrument)
      : voices;

    return {
      rhythms: [...this.applied],
      notes,
      enable,
      triplet,
      rows,
      voices,
      accents,
    };
  }

  private rebuild(): void {
    this.pattern = this.buildPattern();
    this.renderNames();
    this.render();
  }

  /** The name of a rhythm: the factory name, or the name of the user slot. */
  private nameFor(rhythm: number): string {
    if (this.source === PATTERN_SOURCE_USER) {
      return this.names.name(rhythm);
    }
    return RHYTHM_NAMES[rhythm] ?? '';
  }

  private renderNames(): void {
    const user = this.source === PATTERN_SOURCE_USER;
    const signature = `${user ? 'user' : 'preset'}:${this.applied.join(',')}`;

    if (signature !== this.nameSignature) {
      this.nameSignature = signature;
      this.nameRow.replaceChildren();
      this.nameNodes = [];

      for (const rhythm of this.applied) {
        const node = user ? this.buildNameField(rhythm) : this.buildNameText(rhythm);
        this.nameRow.append(node);
        this.nameNodes.push({ rhythm, node });
      }

      this.pendingNode = document.createElement('span');
      this.pendingNode.className = 'pattern-name pattern-name--pending';
      this.pendingNode.title = 'Applied at the end of the current cycle';
      this.nameRow.append(this.pendingNode);
    }

    for (const entry of this.nameNodes) {
      const name = this.nameFor(entry.rhythm);
      if (entry.node instanceof HTMLInputElement) {
        // The field that is being written in keeps the text of the user.
        if (document.activeElement !== entry.node && entry.node.value !== name) {
          entry.node.value = name;
        }
      } else if (entry.node.textContent !== name) {
        entry.node.textContent = name;
      }
    }

    const pending =
      this.pending.length > 0
        ? `→ ${this.pending.map((rhythm) => this.nameFor(rhythm)).join(' + ')}`
        : '';
    if (this.pendingNode !== null && this.pendingNode.textContent !== pending) {
      this.pendingNode.textContent = pending;
    }
  }

  /** The printed name of a factory rhythm. */
  private buildNameText(rhythm: number): HTMLSpanElement {
    const node = document.createElement('span');
    node.className =
      rhythm < 10 ? 'pattern-name pattern-name--a' : 'pattern-name pattern-name--b';
    node.textContent = this.nameFor(rhythm);
    return node;
  }

  /**
   * The name of a user pattern, written on the card. The name of a user
   * pattern is the user's own, so it is a field and not a print.
   */
  private buildNameField(rhythm: number): HTMLInputElement {
    const node = document.createElement('input');
    node.className = `pattern-name pattern-name--input ${
      rhythm < 10 ? 'pattern-name--a' : 'pattern-name--b'
    }`;
    node.type = 'text';
    node.maxLength = MAX_NAME_LENGTH;
    node.value = this.nameFor(rhythm);
    node.setAttribute('aria-label', 'Name of the user pattern');
    node.addEventListener('change', () => {
      this.names.set(rhythm, node.value);
      node.value = this.nameFor(rhythm);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        node.blur();
      }
    });
    return node;
  }

  private render(): void {
    const pattern = this.pattern;
    const width = Math.max(220, this.body.clientWidth);
    const gridWidth = Math.max(120, width - LABEL_WIDTH);
    const columnWidth = gridWidth / PATTERN_COLUMNS;
    const rows = pattern?.rows ?? [];
    // The accent row belongs to the user patterns: the factory rhythms have
    // no accents of their own.
    const accentRow = this.source === PATTERN_SOURCE_USER;
    const totalRows = rows.length + (accentRow ? 1 : 0);
    const height = Math.max(ROW_HEIGHT, totalRows * ROW_HEIGHT);

    this.columnWidth = columnWidth;
    this.rowCount = totalRows;

    this.svg.setAttribute('width', String(Math.round(width)));
    this.svg.setAttribute('height', String(height));
    this.svg.setAttribute('viewBox', `0 0 ${Math.round(width)} ${height}`);

    this.layer.replaceChildren();

    if (pattern === null) {
      this.cursorLayer.setAttribute('display', 'none');
      this.svg.setAttribute(
        'aria-label',
        'Pattern display: no rhythm selected yet.',
      );
      this.playhead.setAttribute('opacity', '0');
      this.updateMeta();
      this.updateState();
      return;
    }

    // The ground of the grid takes the clicks, so a click on an empty step
    // is a click on the grid and not on nothing.
    const ground = svgElement('rect', 'pattern-grid-ground');
    ground.setAttribute('x', '0');
    ground.setAttribute('y', '0');
    ground.setAttribute('width', String(Math.round(width)));
    ground.setAttribute('height', String(height));
    this.layer.append(ground);

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

      // A voice that does not play is printed in a lighter ink: the card
      // shows that it is there and that it is still empty.
      const used = pattern.voices.includes(instrument);
      const label = svgElement(
        'text',
        used
          ? 'pattern-grid-label'
          : 'pattern-grid-label pattern-grid-label--empty',
      );
      label.setAttribute('x', String(LABEL_WIDTH - 8));
      label.setAttribute('y', String(centre));
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('dominant-baseline', 'middle');
      label.textContent = INSTRUMENT_NAMES[instrument] ?? '';
      this.layer.append(label);

      const bit = 1 << instrument;
      if (instrument === GUIRO_INSTRUMENT) {
        this.renderGuiroRow(pattern, centre);
        return;
      }
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

    if (accentRow) {
      this.renderAccentRow(pattern, rows.length * ROW_HEIGHT + ROW_HEIGHT / 2);
    }

    this.renderCursor(pattern);

    this.updateAria(pattern);
    this.updateMeta();
    this.updateState();
    this.updatePlayhead();
  }

  /**
   * The accent row: the steps the engine plays louder.
   *
   * The row is printed in red, the colour of the bank B names.
   */
  private renderAccentRow(pattern: CardPattern, centre: number): void {
    const label = svgElement('text', 'pattern-grid-label');
    label.setAttribute('x', String(LABEL_WIDTH - 8));
    label.setAttribute('y', String(centre));
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = 'Accent';
    this.layer.append(label);

    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      if (pattern.accents[column] !== true) {
        continue;
      }
      const dot = svgElement(
        'circle',
        'pattern-grid-hit pattern-grid-hit--accent',
      );
      dot.setAttribute('cx', String(this.columnCentre(column)));
      dot.setAttribute('cy', String(centre));
      dot.setAttribute('r', String(HIT_RADIUS));
      this.layer.append(dot);
    }
  }

  /**
   * The row of the grid the cursor is on.
   *
   * The card prints the voices that play, and the accent row below them.
   * A voice that the card does not print has no row, so the cursor falls
   * back to the accent row.
   */
  private cursorRowOf(pattern: CardPattern): number {
    return Math.min(this.cursorRow, pattern.rows.length);
  }

  /**
   * The cursor: the step of the grid the keyboard is on.
   */
  private renderCursor(pattern: CardPattern): void {
    if (this.source !== PATTERN_SOURCE_USER) {
      this.cursorLayer.setAttribute('display', 'none');
      return;
    }
    this.cursorLayer.removeAttribute('display');
    this.cursor.setAttribute(
      'x',
      String(this.columnX(this.cursorColumn) - 0.5),
    );
    this.cursor.setAttribute(
      'y',
      String(this.cursorRowOf(pattern) * ROW_HEIGHT + 1),
    );
    this.cursor.setAttribute('width', String(this.columnWidth + 1));
    this.cursor.setAttribute('height', String(ROW_HEIGHT - 2));
  }

  /**
   * The grid is a picture in the preset mode and a switchboard in the
   * extended mode, where the keyboard walks over it.
   */
  private updateAria(pattern: CardPattern): void {
    if (this.source === PATTERN_SOURCE_USER) {
      this.svg.setAttribute('role', 'group');
      this.svg.setAttribute('tabindex', '0');
      // The name of the grid is the step the cursor is on, so a screen
      // reader says where the keyboard is.
      this.svg.setAttribute('aria-label', this.cursorLabel(pattern));
      this.svg.setAttribute('aria-describedby', this.description.id);
      this.layer.setAttribute('aria-hidden', 'true');
      this.description.textContent = `Pattern grid. ${this.describe(pattern)}`;
      this.expandButton.hidden = false;
      return;
    }

    this.svg.setAttribute('role', 'img');
    this.svg.removeAttribute('tabindex');
    this.svg.setAttribute('aria-label', this.describe(pattern));
    this.svg.removeAttribute('aria-describedby');
    this.layer.removeAttribute('aria-hidden');
    this.expandButton.hidden = true;
  }

  /** The step of the grid a click or a key belongs to. */
  private cellAt(
    clientX: number,
    clientY: number,
  ): { row: number; column: number } | null {
    const pattern = this.pattern;
    if (pattern === null) {
      return null;
    }
    const rect = this.svg.getBoundingClientRect();
    const width = Number(this.svg.getAttribute('width') ?? '0');
    const height = Number(this.svg.getAttribute('height') ?? '0');
    if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) {
      return null;
    }

    const x = ((clientX - rect.left) * width) / rect.width;
    const y = ((clientY - rect.top) * height) / rect.height;
    if (x < LABEL_WIDTH || y < 0 || y > height) {
      return null;
    }

    const column = Math.floor((x - LABEL_WIDTH) / this.columnWidth);
    const row = Math.floor(y / ROW_HEIGHT);
    if (column < 0 || column >= PATTERN_COLUMNS) {
      return null;
    }
    // The last row of the grid is the accent row.
    if (row < 0 || row > pattern.rows.length) {
      return null;
    }
    return { row, column };
  }

  /** A click puts a voice into a step, or takes it out again. */
  private onGridClick(event: MouseEvent): void {
    if (this.source !== PATTERN_SOURCE_USER) {
      return;
    }
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell === null) {
      return;
    }
    this.cursorRow = cell.row;
    this.cursorColumn = cell.column;
    this.toggleCell();
    this.render();
  }

  /** The keyboard walks over the grid. */
  private onGridKeyDown(event: KeyboardEvent): void {
    const pattern = this.pattern;
    if (pattern === null || this.source !== PATTERN_SOURCE_USER) {
      return;
    }

    const lastRow = pattern.rows.length;
    let handled = true;
    switch (event.key) {
      case 'ArrowUp':
        this.cursorRow = Math.max(0, this.cursorRow - 1);
        break;
      case 'ArrowDown':
        this.cursorRow = Math.min(lastRow, this.cursorRow + 1);
        break;
      case 'ArrowLeft':
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
        break;
      case 'ArrowRight':
        this.cursorColumn = Math.min(PATTERN_COLUMNS - 1, this.cursorColumn + 1);
        break;
      case 'Home':
        this.cursorColumn = 0;
        break;
      case 'End':
        this.cursorColumn = PATTERN_COLUMNS - 1;
        break;
      case 'PageUp':
        this.cursorColumn = Math.max(
          0,
          this.cursorColumn - PATTERN_STEPS_PER_BAR,
        );
        break;
      case 'PageDown':
        this.cursorColumn = Math.min(
          PATTERN_COLUMNS - 1,
          this.cursorColumn + PATTERN_STEPS_PER_BAR,
        );
        break;
      case 'Enter':
      case ' ':
        this.toggleCell();
        break;
      default:
        handled = false;
    }

    if (!handled) {
      return;
    }
    event.preventDefault();
    this.render();
  }

  /**
   * Put the voice of the row into the step of the cursor, or take it out
   * again. The last row of the grid is the accent row.
   */
  private toggleCell(): void {
    const pattern = this.pattern;
    if (pattern === null) {
      return;
    }
    const column = this.cursorColumn;

    if (this.cursorRowOf(pattern) >= pattern.rows.length) {
      const accent = pattern.accents[column] !== true;
      this.onAccent?.(column, accent);
      return;
    }

    const instrument = pattern.rows[this.cursorRowOf(pattern)] ?? 0;
    const bit = 1 << instrument;
    const on = ((pattern.notes[column] ?? 0) & bit) === 0;
    this.onToggle?.(instrument, column, on);
  }

  /** What the cursor points at, for the screen reader. */
  private cursorLabel(pattern: CardPattern): string {
    const step = this.cursorColumn + 1;
    if (this.cursorRowOf(pattern) >= pattern.rows.length) {
      const accented = pattern.accents[this.cursorColumn] === true;
      return `Accent on step ${step}: ${accented ? 'on' : 'off'}`;
    }
    const instrument = pattern.rows[this.cursorRowOf(pattern)] ?? 0;
    const name = INSTRUMENT_NAMES[instrument] ?? '';
    const bit = 1 << instrument;
    const plays = ((pattern.notes[this.cursorColumn] ?? 0) & bit) !== 0;
    return `${name} on step ${step}: ${plays ? 'plays' : 'empty'}`;
  }

  /**
   * The runs of the Guiro row, in the order the machine plays them.
   *
   * A run is a stretch of columns the engine visits one after the other
   * and in which the Guiro is hit every time. The gate stays open over
   * such a stretch, so the machine plays it as one roll. A disabled
   * column in the middle does not break the run: the engine skips it
   * instead of waiting for it, so the roll goes on.
   */
  private guiroRuns(pattern: CardPattern): number[][] {
    const bit = 1 << GUIRO_INSTRUMENT;
    const visited: number[] = [];
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      if (this.isEnabled(pattern, column)) {
        visited.push(column);
      }
    }
    if (visited.length === 0) {
      return [];
    }

    const hasGuiro = (column: number): boolean =>
      ((pattern.notes[column] ?? 0) & bit) !== 0;

    // The scan starts behind a column without a hit, so a run that runs
    // over the end of the cycle is not cut in two.
    const quiet = visited.findIndex((column) => !hasGuiro(column));
    if (quiet < 0) {
      // Every visited column is hit: the whole cycle is one run.
      return [visited];
    }
    const ordered = visited
      .slice(quiet + 1)
      .concat(visited.slice(0, quiet + 1));

    const runs: number[][] = [];
    let run: number[] = [];
    for (const column of ordered) {
      if (hasGuiro(column)) {
        run.push(column);
        continue;
      }
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) {
      runs.push(run);
    }
    return runs;
  }

  /**
   * The parts of a run that lie next to each other on the card. A run
   * that runs over the end of the cycle is printed as two parts.
   */
  private guiroParts(run: number[]): number[][] {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) {
      return [];
    }
    if (first <= last) {
      return [run];
    }
    const tail = run.filter((column) => column >= first);
    const head = run.filter((column) => column <= last);
    return [tail, head];
  }

  /**
   * The Guiro row: a run of hits is printed as a bar with a dot at each
   * end, so the card shows the roll the machine plays.
   */
  private renderGuiroRow(pattern: CardPattern, centre: number): void {
    for (const run of this.guiroRuns(pattern)) {
      for (const part of this.guiroParts(run)) {
        const first = part[0];
        const last = part[part.length - 1];
        if (first === undefined || last === undefined) {
          continue;
        }
        if (first !== last) {
          const bar = svgElement('line', 'pattern-grid-gate');
          bar.setAttribute('x1', String(this.columnCentre(first)));
          bar.setAttribute('x2', String(this.columnCentre(last)));
          bar.setAttribute('y1', String(centre));
          bar.setAttribute('y2', String(centre));
          this.layer.append(bar);
        }
        this.drawGuiroHit(first, centre);
        if (last !== first) {
          this.drawGuiroHit(last, centre);
        }
      }
    }
  }

  private drawGuiroHit(column: number, centre: number): void {
    const hit = svgElement('circle', 'pattern-grid-hit pattern-grid-hit--perc');
    hit.setAttribute('cx', String(this.columnCentre(column)));
    hit.setAttribute('cy', String(centre));
    hit.setAttribute('r', String(HIT_RADIUS));
    this.layer.append(hit);
  }

  private describe(pattern: CardPattern): string {
    const names = pattern.rhythms
      .map((rhythm) => this.nameFor(rhythm))
      .filter((name) => name !== '');
    const title =
      names.length > 0 ? names.join(' plus ') : 'the percussion layer only';
    const parts: string[] = [];
    for (const instrument of pattern.voices) {
      if (instrument === GUIRO_INSTRUMENT) {
        parts.push(this.describeGuiro(pattern));
        continue;
      }
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

    const accents = pattern.accents
      .map((accented, column) => (accented ? column + 1 : 0))
      .filter((column) => column > 0);
    if (accents.length > 0) {
      const rest = accents.length > MAX_SPOKEN_COLUMNS ? ', and more' : '';
      parts.push(
        `accents on ${accents.slice(0, MAX_SPOKEN_COLUMNS).join(', ')}${rest}`,
      );
    }

    if (parts.length === 0) {
      return `Pattern display for ${title}. The pattern is empty.`;
    }
    return `Pattern display for ${title}. ${parts.join('; ')}.`;
  }

  /**
   * The Guiro row is spoken as the rolls the machine plays, because that
   * is how the card prints it. The rolls are named in the order of the
   * card, not in the order the machine plays them.
   */
  private describeGuiro(pattern: CardPattern): string {
    const parts: number[][] = [];
    for (const run of this.guiroRuns(pattern)) {
      for (const part of this.guiroParts(run)) {
        parts.push(part);
      }
    }
    parts.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));

    const spoken = parts.map((part) => {
      const first = part[0] ?? 0;
      const last = part[part.length - 1] ?? first;
      return first === last ? `${first + 1}` : `${first + 1} to ${last + 1}`;
    });
    if (spoken.length === 0) {
      return 'Guiro silent';
    }
    const rest = spoken.length > MAX_SPOKEN_COLUMNS ? ', and more' : '';
    return `Guiro rolling over ${spoken.slice(0, MAX_SPOKEN_COLUMNS).join(', ')}${rest}`;
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

    if (this.source === PATTERN_SOURCE_USER) {
      const user = document.createElement('span');
      user.className = 'pattern-flag pattern-flag--user';
      user.textContent = 'USER';
      this.metaRow.append(user);
    }

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
    } else if (this.pattern.voices.length === 0) {
      text = 'The pattern is empty';
    } else {
      const voices = this.pattern.voices.length;
      const rows = this.showsAllVoices()
        ? `${voices} of ${INSTRUMENT_NAMES.length} instruments`
        : `${voices} instrument${voices === 1 ? '' : 's'}`;
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
