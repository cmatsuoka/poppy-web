/*
 * user-store.ts - the user patterns between two visits.
 *
 * The engine holds the 20 user pattern slots while the page is open. The
 * patterns the user has written are kept in the browser, so the work is
 * still there after a reload. Only the patterns that were touched are
 * stored: every slot that was never written keeps the rhythm it came up
 * with, and the browser does not hold a copy of it.
 *
 * A pattern is stored the way the engine holds it: the 64 columns of the
 * cycle, the time signature it plays on and the length of the repeating
 * part. The mask of the steps the machine plays is not stored: the engine
 * derives it from the signature.
 */

import {
  PATTERN_COLUMNS,
  timesigOf,
  type UserPattern,
} from '../audio/protocol';

const STORAGE_KEY = 'poppy-web.user-patterns.v2';

interface StoredPattern {
  notes: number[];
  timesig: number;
  period: number;
}

function isStoredPattern(value: unknown): value is StoredPattern {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const pattern = value as Partial<StoredPattern>;
  if (!Array.isArray(pattern.notes)) {
    return false;
  }
  if (pattern.notes.length !== PATTERN_COLUMNS) {
    return false;
  }
  return pattern.notes.every(
    (note) => typeof note === 'number' && note >= 0 && note <= 0xffff,
  );
}

/**
 * The user patterns of the last visit, if there are any.
 *
 * A browser that does not let the page store anything is not an error: the
 * patterns are simply not kept.
 */
export function loadUserPatterns(): Map<number, UserPattern> {
  const patterns = new Map<number, UserPattern>();

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return patterns;
  }
  if (raw === null) {
    return patterns;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return patterns;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return patterns;
  }

  const entries = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    if (!isStoredPattern(value)) {
      continue;
    }
    patterns.set(index, {
      notes: [...value.notes],
      timesig: timesigOf(value.timesig ?? 0),
      period: value.period,
    });
  }

  return patterns;
}

/** Keep the user patterns for the next visit. */
export function saveUserPatterns(patterns: Map<number, UserPattern>): void {
  const stored: Record<string, StoredPattern> = {};
  for (const [index, pattern] of patterns) {
    stored[String(index)] = {
      notes: [...pattern.notes],
      timesig: pattern.timesig,
      period: pattern.period,
    };
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A browser that does not let the page store anything simply does not
    // keep the patterns.
  }
}
