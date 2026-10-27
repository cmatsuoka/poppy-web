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
 * The names are kept in the browser, like the patterns themselves, so the
 * user finds them again after a reload.
 */

const STORAGE_KEY = 'poppy-web.user-names.v1';

/** The number of characters a name may have. */
export const MAX_NAME_LENGTH = 10;

/** The name a user pattern has until it is given another one. */
export function defaultUserName(slot: number): string {
  return `USER ${String(slot + 1).padStart(2, '0')}`;
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
    return this.names.get(slot) ?? defaultUserName(slot);
  }

  /** Give a user pattern another name. */
  set(slot: number, name: string): void {
    const next = normalizeUserName(name);
    if (next === '' || next === this.name(slot)) {
      return;
    }
    this.names.set(slot, next);
    this.save();
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

  private save(): void {
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
}
