/*
 * user-names.ts - the names of the user patterns.
 *
 * The twenty user patterns carry a name of their own. The panel prints it
 * on the key bed in the extended mode, where it takes the place of the
 * factory name, and the pattern card lets it be edited.
 *
 * A name is printed in one column of the key bed, so it is kept short: ten
 * characters, the length of "BOSSA NOVA", the longest factory name.
 *
 * A name belongs to the pattern it names, so it is kept in the browser the
 * way the pattern is: when the save button is pressed, and not before. The
 * work that was not saved is thrown away as a whole, and the name of a
 * pattern goes back to the name the browser holds with it.
 */

import { ADVANCED_NAMES } from '../audio/protocol';

const STORAGE_KEY = 'poppy-web.user-names.v1';

/** The number of characters a name may have. */
export const MAX_NAME_LENGTH = 10;

/** The name a user pattern has until it is given another one. */
export function defaultUserName(slot: number): string {
  return `USER ${String(slot + 1).padStart(2, '0')}`;
}

/**
 * The name the rhythm of a slot comes up with.
 *
 * The slots are not empty when the machine comes up: they hold the
 * rhythms of the two banks, and the name of a rhythm is the name the
 * machine gives it. A slot without a rhythm of its own has no name of its
 * own either.
 */
export function defaultBankName(slot: number): string | null {
  return ADVANCED_NAMES[slot] ?? null;
}

/**
 * The printed form of a name: upper case, without the spaces at the ends
 * and not longer than the column it is printed in.
 */
export function normalizeUserName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase().slice(0, MAX_NAME_LENGTH);
}

/**
 * The names of the user patterns.
 *
 * The panel and the pattern card share one instance: a name that is edited
 * on the card is the name the key bed prints right away.
 */
export class UserNames {
  private readonly names = new Map<number, string>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.load();
  }

  /** The name of a user pattern, the default one if it was never renamed. */
  name(slot: number): string {
    return this.names.get(slot) ?? defaultBankName(slot) ?? defaultUserName(slot);
  }

  /**
   * Give a user pattern another name.
   *
   * It tells whether the name changed: a name that is the same as the one
   * the pattern already carries is not a change.
   */
  set(slot: number, name: string): boolean {
    const next = normalizeUserName(name);
    if (next === '' || next === this.name(slot)) {
      return false;
    }
    this.names.set(slot, next);
    this.notify();
    return true;
  }

  /**
   * Give a whole set of user patterns their names at once.
   *
   * A bank that is read from a file carries the names of its ten rhythms,
   * and they are all written at once: the panel is told once.
   */
  setMany(names: Map<number, string>): boolean {
    let changed = false;
    for (const [slot, name] of names) {
      const next = normalizeUserName(name);
      if (next === '' || next === this.name(slot)) {
        continue;
      }
      this.names.set(slot, next);
      changed = true;
    }
    if (!changed) {
      return false;
    }
    this.notify();
    return true;
  }

  /**
   * Keep the names in the browser.
   *
   * The names are written with the patterns they belong to, when the save
   * button is pressed.
   */
  save(): void {
    const stored: Record<string, string> = {};
    for (const [slot, name] of this.names) {
      stored[String(slot)] = name;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // A browser that does not let the page store anything simply does not
      // keep the names.
    }
  }

  /**
   * Put the names the browser holds back.
   *
   * A name that was written but not saved is gone, the way the pattern it
   * names is gone: a slot that was never saved goes back to the default
   * name.
   */
  restore(): void {
    this.names.clear();
    this.load();
    this.notify();
  }

  /** Watch the names. It is called after every change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (raw === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const slot = Number(key);
      if (!Number.isInteger(slot) || slot < 0 || typeof value !== 'string') {
        continue;
      }
      const name = normalizeUserName(value);
      if (name !== '') {
        this.names.set(slot, name);
      }
    }
  }
}
