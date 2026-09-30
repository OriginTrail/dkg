/**
 * Needs no devnet: pins the log-window helper that the live suite uses to decide
 * whether the daemon logged persistence trouble DURING the run. The case that
 * motivated it: old matching lines vanish when the daemon rotates its log on a
 * restart, and a fresh matching line must still be reported.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOG_MARK_FINGERPRINT_BYTES,
  LOG_MARK_MAX_LINE_SCAN_BYTES,
  LOG_MARK_SCAN_CHUNK_BYTES,
  markLog,
  matchingLinesSince,
  readLogSince,
} from './log-window.js';

const TROUBLE = [/persistence did not drain/i, /Failed to persist/i];

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spr-log-window-'));
  file = join(dir, 'daemon.log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A log line no pattern matches. `padding` widens it so a few lines fill a fingerprint. */
function quiet(index: number, padding = 0): string {
  return `2026-09-30 10:00:${String(index % 60).padStart(2, '0')} [DKGAgent] heartbeat ${index}${'.'.repeat(padding)}\n`;
}

const oldTrouble = (index: number): string =>
  `2026-09-29 09:00:0${index} [DKGAgent] Failed to persist context-graph subscription for "old-${index}": disk full\n`;

const freshTrouble = 'DKGAgent.stop: context-graph subscription persistence did not drain within 5000ms\n';

/** The start of a matching line that a test leaves unterminated and finishes after the mark. */
const TROUBLE_HEAD = 'Failed to persist context-graph subscription for "big": ';
const TROUBLE_TAIL = ' disk full';

/** The daemon's startup rotation: keep only the tail of an oversized log, in place. */
function rotate(keepLastBytes: number): void {
  const content = readFileSync(file);
  const tail = content.subarray(content.length - keepLastBytes);
  writeFileSync(file, tail.subarray(tail.indexOf(0x0a) + 1));
}

describe('log window', () => {
  it('returns only the lines written after the mark and ignores older matching lines', () => {
    writeFileSync(file, oldTrouble(1) + quiet(1) + oldTrouble(2));
    const mark = markLog(file);

    appendFileSync(file, quiet(2) + freshTrouble + quiet(3));

    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual([freshTrouble.trim()]);
  });

  it('reports no lines when nothing matching was written after the mark', () => {
    writeFileSync(file, oldTrouble(1) + oldTrouble(2));
    const mark = markLog(file);
    appendFileSync(file, quiet(1) + quiet(2));
    expect(matchingLinesSince(file, mark, TROUBLE)).toEqual({ lines: [], rotated: false });
  });

  it('does not let old matched lines that disappear hide a fresh matched line', () => {
    // Two old warnings before the run, the reviewer's example, filling the log.
    const padding = 2_000;
    writeFileSync(file, oldTrouble(1) + oldTrouble(2) + Array.from({ length: 6 }, (_, i) => quiet(i, padding)).join(''));
    const before = readFileSync(file, 'utf8').split('\n').filter((line) => TROUBLE.some((p) => p.test(line)));
    expect(before).toHaveLength(2);
    const mark = markLog(file);

    // The daemon restarts and rotates: the oldest bytes, both old warnings
    // included, are dropped. The run then logs one fresh drain-timeout warning.
    rotate(9_000);
    expect(readFileSync(file, 'utf8')).not.toMatch(/Failed to persist/);
    appendFileSync(file, freshTrouble);

    // The count-slice this helper replaces: one match now, two skipped, none reported.
    const legacy = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => TROUBLE.some((pattern) => pattern.test(line)))
      .slice(before.length);
    expect(legacy).toEqual([]);

    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(true);
    expect(lines).toEqual([freshTrouble.trim()]);
  });

  it('detects a rotation that grew back past the recorded offset', () => {
    writeFileSync(file, Array.from({ length: 12 }, (_, i) => quiet(i, 1_500)).join(''));
    const mark = markLog(file);
    const size = readFileSync(file).length;

    rotate(Math.floor(size / 2));
    // The daemon keeps logging, so the file is longer than the mark again, but
    // the bytes before the mark are no longer the ones that were recorded.
    appendFileSync(file, Array.from({ length: 12 }, (_, i) => quiet(100 + i, 1_500)).join(''));
    appendFileSync(file, freshTrouble);
    expect(readFileSync(file).length).toBeGreaterThan(mark.offset);

    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(true);
    expect(lines).toEqual([freshTrouble.trim()]);
  });

  it('treats a retained old matching line as new once the log was rotated', () => {
    writeFileSync(file, quiet(0, 500) + oldTrouble(1) + quiet(1, 500));
    const mark = markLog(file);
    // Truncated to an empty file and refilled: the retained line cannot be told from a fresh one.
    writeFileSync(file, oldTrouble(2));
    appendFileSync(file, quiet(2));

    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(true);
    expect(lines).toEqual([oldTrouble(2).trim()]);
  });

  it('reads a log that is shorter than the mark from its start', () => {
    writeFileSync(file, Array.from({ length: 5 }, (_, i) => quiet(i, 200)).join(''));
    const mark = markLog(file);
    writeFileSync(file, freshTrouble);
    expect(readLogSince(file, mark)).toEqual({ text: freshTrouble, rotated: true });
  });

  it('counts a missing log as offset zero and reads a log that appears later from its start', () => {
    const mark = markLog(file);
    expect(mark.offset).toBe(0);
    expect(readLogSince(file, mark)).toEqual({ text: '', rotated: false });

    writeFileSync(file, quiet(1) + freshTrouble);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual([freshTrouble.trim()]);
  });

  it('flags a log that vanished after a mark past offset zero as rotated, with no text', () => {
    writeFileSync(file, quiet(1) + quiet(2));
    const mark = markLog(file);
    rmSync(file);
    expect(readLogSince(file, mark)).toEqual({ text: '', rotated: true });
  });

  it('starts the window on a line boundary so a line still being written is read whole', () => {
    writeFileSync(file, quiet(1) + 'Failed to per');
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(quiet(1)));

    appendFileSync(file, 'sist context-graph subscription for "half": disk full\n');
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual(['Failed to persist context-graph subscription for "half": disk full']);
  });

  it('measures the offset in bytes, not characters, when the log holds multi-byte text', () => {
    const wide = `${'—'.repeat(40)} restart ${'é'.repeat(30)}\n`;
    writeFileSync(file, wide + wide);
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(wide + wide));
    expect(mark.offset).toBeGreaterThan((wide + wide).length);

    appendFileSync(file, freshTrouble);
    expect(readLogSince(file, mark)).toEqual({ text: freshTrouble, rotated: false });
  });

  it('caps the fingerprint so marking a large log stays cheap', () => {
    writeFileSync(file, Array.from({ length: 40 }, (_, i) => quiet(i, 500)).join(''));
    const mark = markLog(file);
    expect(mark.fingerprint.length).toBeLessThanOrEqual(LOG_MARK_FINGERPRINT_BYTES);
    expect(mark.offset).toBe(readFileSync(file).length);
  });
});

/**
 * The mark of a log whose last line is still being written must never advance
 * past the START of that line, however long the line already is. A mark inside
 * the line (or at the end of the file) would leave the line's beginning, which
 * is where a failure prefix such as "Failed to persist ..." lives, outside the
 * window, so the finished line would no longer match.
 */
describe('log window with an unterminated last line', () => {
  const unterminated = (length: number): string => TROUBLE_HEAD + 'x'.repeat(length - TROUBLE_HEAD.length);
  const lineLengths = [
    ['just under the fingerprint window', LOG_MARK_FINGERPRINT_BYTES - 1],
    ['exactly the fingerprint window', LOG_MARK_FINGERPRINT_BYTES],
    ['one byte over the fingerprint window', LOG_MARK_FINGERPRINT_BYTES + 1],
    ['several fingerprint windows', LOG_MARK_FINGERPRINT_BYTES * 5 + 7],
    ['one byte under a scan chunk', LOG_MARK_SCAN_CHUNK_BYTES - 1],
    ['exactly a scan chunk', LOG_MARK_SCAN_CHUNK_BYTES],
    ['one byte over a scan chunk', LOG_MARK_SCAN_CHUNK_BYTES + 1],
    ['several scan chunks', LOG_MARK_SCAN_CHUNK_BYTES * 3 + 11],
  ] as const;

  it("reports a matching line that was longer than the fingerprint window when it was marked (the reviewer's case)", () => {
    const partial = unterminated(LOG_MARK_FINGERPRINT_BYTES + 100);
    writeFileSync(file, quiet(1) + partial);
    const mark = markLog(file);
    expect(mark.offset, 'the window starts where the unfinished line starts').toBe(Buffer.byteLength(quiet(1)));

    appendFileSync(file, `${TROUBLE_TAIL}\n${quiet(2)}`);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual([partial + TROUBLE_TAIL]);
  });

  it.each(lineLengths)('starts the window at an unfinished line that is %s, and reports the finished line whole', (_label, length) => {
    const before = quiet(1, 300) + oldTrouble(1) + quiet(2, 300);
    const partial = unterminated(length);
    writeFileSync(file, before + partial);
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(before));
    expect(mark.fingerprint.length).toBeLessThanOrEqual(LOG_MARK_FINGERPRINT_BYTES);

    appendFileSync(file, `${TROUBLE_TAIL}\n${quiet(3)}${freshTrouble}`);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    // The old matching line before the mark stays outside; the finished line and a later one count.
    expect(lines).toEqual([partial + TROUBLE_TAIL, freshTrouble.trim()]);
  });

  it.each([
    ['empty', 0],
    ['shorter than the fingerprint window', 40],
    ['exactly the fingerprint window', LOG_MARK_FINGERPRINT_BYTES],
    ['one byte over the fingerprint window', LOG_MARK_FINGERPRINT_BYTES + 1],
    ['one byte over a scan chunk', LOG_MARK_SCAN_CHUNK_BYTES + 1],
    ['exactly the scan bound', LOG_MARK_MAX_LINE_SCAN_BYTES],
    ['over the scan bound', LOG_MARK_MAX_LINE_SCAN_BYTES + LOG_MARK_SCAN_CHUNK_BYTES + 3],
  ] as const)('reads a log with no newline at all, %s, from its start', (_label, length) => {
    const partial = length === 0 ? '' : unterminated(Math.max(length, TROUBLE_HEAD.length));
    writeFileSync(file, partial);
    const mark = markLog(file);
    expect(mark).toEqual({ offset: 0, fingerprint: Buffer.alloc(0) });

    appendFileSync(file, `${partial === '' ? TROUBLE_HEAD : ''}${TROUBLE_TAIL}\n`);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual([(partial === '' ? TROUBLE_HEAD : partial) + TROUBLE_TAIL]);
  });

  it('marks the end of a log that ends exactly on a newline, even after a line longer than the fingerprint window', () => {
    const long = `${unterminated(LOG_MARK_FINGERPRINT_BYTES * 3)}\n`;
    writeFileSync(file, quiet(1) + long);
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(quiet(1) + long));
    expect(mark.fingerprint.length).toBe(LOG_MARK_FINGERPRINT_BYTES);

    appendFileSync(file, quiet(2));
    expect(matchingLinesSince(file, mark, TROUBLE)).toEqual({ lines: [], rotated: false });
  });

  it('finds the line start of an unfinished line that spans scan chunks and starts with multi-byte text', () => {
    // A 3-byte character straddles every chunk boundary the backward scan reads.
    const wide = '—'.repeat(Math.ceil((LOG_MARK_SCAN_CHUNK_BYTES * 2 + 100) / 3));
    const partial = `${TROUBLE_HEAD}${wide}`;
    const before = `${'é'.repeat(50)} restart ${'—'.repeat(20)}\n`;
    writeFileSync(file, before + partial);
    const bytes = readFileSync(file);
    for (const boundary of [bytes.length - LOG_MARK_SCAN_CHUNK_BYTES, bytes.length - 2 * LOG_MARK_SCAN_CHUNK_BYTES]) {
      expect(bytes[boundary]! & 0xc0, `the byte at ${boundary} must be inside a character`).toBe(0x80);
    }

    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(before));
    expect(mark.offset).toBeGreaterThan(before.length);

    appendFileSync(file, `${TROUBLE_TAIL}\n`);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    expect(lines).toEqual([partial + TROUBLE_TAIL]);
    expect(lines[0]).not.toContain('\uFFFD');
  });

  it('scans back as far as the bound: an unfinished line one byte shorter than it is still found', () => {
    const before = oldTrouble(1) + quiet(1, 300);
    const partial = unterminated(LOG_MARK_MAX_LINE_SCAN_BYTES - 1);
    writeFileSync(file, before + partial);
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(before));

    appendFileSync(file, `${TROUBLE_TAIL}\n`);
    const { lines } = matchingLinesSince(file, mark, TROUBLE);
    expect(lines).toEqual([partial + TROUBLE_TAIL]);
  });

  it('falls back to the whole file, over-reporting but never hiding a line, when the unfinished line is longer than the bound', () => {
    const before = oldTrouble(1) + quiet(1, 300);
    const partial = unterminated(LOG_MARK_MAX_LINE_SCAN_BYTES);
    writeFileSync(file, before + partial);
    const mark = markLog(file);
    expect(mark).toEqual({ offset: 0, fingerprint: Buffer.alloc(0) });

    appendFileSync(file, `${TROUBLE_TAIL}\n`);
    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(false);
    // The old line is blamed on this run (the price of not finding the line start), and the finished line is there.
    expect(lines).toEqual([oldTrouble(1).trim(), partial + TROUBLE_TAIL]);
  });

  it('still detects a rotation when the mark sits at the start of an oversized unfinished line', () => {
    const before = Array.from({ length: 10 }, (_, i) => quiet(i, 1_000)).join('');
    const partial = unterminated(LOG_MARK_FINGERPRINT_BYTES * 3);
    writeFileSync(file, before + partial);
    const mark = markLog(file);
    expect(mark.offset).toBe(Buffer.byteLength(before));
    expect(mark.fingerprint.length).toBe(LOG_MARK_FINGERPRINT_BYTES);

    // The daemon restarts and rotates in place, dropping the oldest bytes, then logs on.
    rotate(Math.floor(readFileSync(file).length / 2));
    appendFileSync(file, `${TROUBLE_TAIL}\n${quiet(50)}${freshTrouble}`);

    const { lines, rotated } = matchingLinesSince(file, mark, TROUBLE);
    expect(rotated).toBe(true);
    expect(lines).toEqual([freshTrouble.trim()]);
  });
});
