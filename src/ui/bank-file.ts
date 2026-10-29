/*
 * bank-file.ts - a whole bank of rhythms as a file.
 *
 * A bank is the ten user patterns of one bank of the key bed. The file
 * holds all of them, with their names, so a bank can be carried from one
 * machine to another and put back on the other one as it was.
 *
 * The format is JSON: it is easy to read, easy to write and easy to check.
 * A rhythm is written the way the engine holds it: the 64 steps of the
 * cycle, each of them a bit for every voice of the machine and a bit for
 * the accent, and the steps the engine skips. The file says what it is
 * and which version of the format it uses, so a file of another program or
 * of another version is refused instead of being half read.
 */

import { PATTERN_COLUMNS, type Bank, type UserPattern } from '../audio/protocol';

/** The name the format carries in every file. */
export const BANK_FILE_FORMAT = 'poppy-web.bank';

/** The version of the format this build reads and writes. */
export const BANK_FILE_VERSION = 3;

/** The number of rhythms a bank holds. */
export const BANK_PATTERN_COUNT = 10;

/** One rhythm of a bank, as it is written in the file. */
export interface BankFilePattern {
  /** The name the pattern carries on the key bed. */
  name: string;
  /**
   * The 64 steps of the cycle.
   *
   * Every step is a bit for every voice of the machine and a bit for the
   * accent, in the order the engine numbers them: the bass is the first
   * bit, the quijada the fifteenth, and the accent the sixteenth.
   */
  steps: number[];
  /** The steps the engine skips: they take no time. */
  skipped: number[];
  /** The length of the repeating part of the cycle. */
  period: number;
  /** Whether the rhythm is played as a triplet. */
  triplet: boolean;
}

/** A whole bank of rhythms, as it is written in the file. */
export interface BankFile {
  format: string;
  version: number;
  /** The bank the rhythms came from: 0 is A, 1 is B. */
  bank: Bank;
  patterns: BankFilePattern[];
}

/** The name of the file of a bank. */
export function bankFileName(bank: Bank): string {
  return `bank-${bank === 1 ? 'b' : 'a'}.json`;
}

/** Put a bank of rhythms together, ready to be written. */
export function buildBankFile(
  bank: Bank,
  patterns: BankFilePattern[],
): BankFile {
  return {
    format: BANK_FILE_FORMAT,
    version: BANK_FILE_VERSION,
    bank,
    patterns,
  };
}

/** Write a pattern of the engine as the steps of a file. */
export function patternToFile(
  pattern: UserPattern,
  name: string,
): BankFilePattern {
  const skipped: number[] = [];
  for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
    const enabled =
      column < 32
        ? ((pattern.enableLo >>> 0) & (1 << column)) !== 0
        : ((pattern.enableHi >>> 0) & (1 << (column - 32))) !== 0;
    if (!enabled) {
      skipped.push(column + 1);
    }
  }

  return {
    name,
    steps: pattern.notes.map((note) => (note ?? 0) & 0xffff),
    skipped,
    period: pattern.period,
    triplet: pattern.triplet,
  };
}

/** Read a rhythm of a file back as a pattern of the engine. */
export function patternFromFile(pattern: BankFilePattern): UserPattern {
  let enableLo = 0xffffffff;
  let enableHi = 0xffffffff;
  for (const step of pattern.skipped) {
    if (step <= 32) {
      enableLo &= ~(1 << (step - 1));
    } else {
      enableHi &= ~(1 << (step - 33));
    }
  }

  return {
    notes: pattern.steps.map((step) => step & 0xffff),
    enableLo: enableLo >>> 0,
    enableHi: enableHi >>> 0,
    period: pattern.period,
    triplet: pattern.triplet,
  };
}

function isPeriod(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return false;
  }
  if (value < 1 || value > PATTERN_COLUMNS) {
    return false;
  }
  // The cycle repeats the pattern every `period` columns, so the period
  // has to divide the cycle in whole steps.
  return (value & (value - 1)) === 0;
}

function isStepNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PATTERN_COLUMNS
  );
}

/**
 * Read one step of a file.
 *
 * A step is a bit for every voice of the machine and a bit for the accent,
 * so it is a number of sixteen bits.
 */
function isStep(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff
  );
}

function isBankFilePattern(value: unknown): value is BankFilePattern {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const pattern = value as Partial<BankFilePattern>;
  if (typeof pattern.name !== 'string') {
    return false;
  }
  if (!Array.isArray(pattern.steps)) {
    return false;
  }
  if (pattern.steps.length !== PATTERN_COLUMNS) {
    return false;
  }
  if (!pattern.steps.every(isStep)) {
    return false;
  }
  if (!Array.isArray(pattern.skipped)) {
    return false;
  }
  if (!pattern.skipped.every(isStepNumber)) {
    return false;
  }
  if (!isPeriod(pattern.period)) {
    return false;
  }
  return typeof pattern.triplet === 'boolean';
}

/**
 * Read a bank of rhythms out of a file.
 *
 * A file that is not a bank of rhythms, or that is damaged, is refused
 * with a message that says what is wrong with it. Nothing is thrown away
 * before the file has been read to the end.
 */
export function parseBankFile(text: string): BankFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The file is not a bank of rhythms: it is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('The file is not a bank of rhythms');
  }

  const file = parsed as Partial<BankFile>;
  if (file.format !== BANK_FILE_FORMAT) {
    throw new Error('The file is not a bank of rhythms');
  }
  if (file.version !== BANK_FILE_VERSION) {
    throw new Error(
      `The file is a bank of rhythms of another version (${String(file.version)})`,
    );
  }
  if (file.bank !== 0 && file.bank !== 1) {
    throw new Error('The file does not say which bank it holds');
  }
  if (!Array.isArray(file.patterns)) {
    throw new Error('The file holds no rhythms');
  }
  if (file.patterns.length !== BANK_PATTERN_COUNT) {
    throw new Error(
      `A bank holds ${BANK_PATTERN_COUNT} rhythms, and the file holds ${file.patterns.length}`,
    );
  }
  if (!file.patterns.every(isBankFilePattern)) {
    throw new Error('The file holds a rhythm that is not one of ours');
  }

  return {
    format: file.format,
    version: file.version,
    bank: file.bank as Bank,
    patterns: file.patterns.map((pattern) => ({
      name: pattern.name,
      steps: [...pattern.steps],
      skipped: [...new Set(pattern.skipped)].sort((a, b) => a - b),
      period: pattern.period,
      triplet: pattern.triplet,
    })),
  };
}

/**
 * Write a bank of rhythms as JSON.
 *
 * The lists of numbers are written on one line: a rhythm is a line of
 * numbers, and the file stays small enough to be read.
 */
export function stringifyBankFile(file: BankFile): string {
  const text = JSON.stringify(file, null, 2);
  return `${text.replace(
    /\[\s*(\d+(?:,\s*\d+)*)\s*\]/g,
    (_match: string, numbers: string) => `[${numbers.replace(/\s+/g, ' ')}]`,
  )}\n`;
}

/**
 * Write a bank of rhythms to a file, and let the browser hand it to the
 * user.
 */
export function downloadBankFile(file: BankFile): void {
  const text = stringifyBankFile(file);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = bankFileName(file.bank);
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();

  // The browser needs the address of the file while the download starts,
  // so it is released a moment later and not at once.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Let the user pick a bank of rhythms, and read it.
 *
 * The promise is settled with the bank that was picked, or with nothing
 * when the user lets the dialog go without picking a file. A file that
 * cannot be read is an error the caller can show.
 */
export function chooseBankFile(): Promise<BankFile | null> {
  return new Promise<BankFile | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';

    let settled = false;
    let picked = false;

    const settle = (value: BankFile | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(value);
    };

    const fail = (reason: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    const onFocus = (): void => {
      // The dialog is closed. A file that was picked is read by the change
      // event, which comes right after this one; a dialog that was let go
      // without a file says so with the cancel event.
      window.setTimeout(() => {
        if (picked || (input.files?.length ?? 0) > 0) {
          return;
        }
        settle(null);
      }, 600);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        settle(null);
        return;
      }
      picked = true;
      file
        .text()
        .then((text) => {
          settle(parseBankFile(text));
        })
        .catch(fail);
    });
    input.addEventListener('cancel', () => settle(null));

    document.body.append(input);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
