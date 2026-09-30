/**
 * Read only the part of a daemon log written after a recorded point, and say
 * when the log stopped continuing from that point.
 *
 * A suite that asserts "the daemon logged no persistence trouble during this
 * run" must not compare match COUNTS before and after: a daemon that restarts
 * three times can rotate its log in between (`rotateDaemonLogIfNeeded` rewrites
 * an oversized `daemon.log` in place, keeping only its tail), which removes old
 * matching lines and would make "skip the first N matches" swallow fresh ones.
 * Instead the window is delimited by a BYTE OFFSET recorded before the first
 * action, guarded by a fingerprint of the bytes just before it:
 *
 *  - The log still continues from the mark when it is at least `offset` bytes
 *    long and those bytes are unchanged. The window is everything after them.
 *  - Otherwise it was rotated or truncated (a shorter file, or an in-place
 *    rewrite that grew back past the offset), the offset means nothing, and the
 *    WHOLE file is the window: every matching line counts as new. That can only
 *    over-report (a retained old line is blamed on this run), never hide one.
 *
 * Offsets are bytes, never string indices: the log contains multi-byte
 * characters, so a character index into decoded text is not a file offset.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/** How many bytes before the mark must still match for the log to count as continuous. */
export const LOG_MARK_FINGERPRINT_BYTES = 4096;

export interface LogMark {
  /** Byte offset where the window starts: just past the last complete line at mark time. */
  readonly offset: number;
  /** The bytes right before `offset` (at most {@link LOG_MARK_FINGERPRINT_BYTES}). */
  readonly fingerprint: Buffer;
}

export interface LogWindow {
  readonly text: string;
  /** True when the log did not continue from the mark, so `text` is the whole file. */
  readonly rotated: boolean;
}

export interface MatchedLogLines {
  readonly lines: string[];
  readonly rotated: boolean;
}

function readFully(fd: number, into: Buffer, position: number): number {
  let total = 0;
  while (total < into.length) {
    const read = readSync(fd, into, total, into.length - total, position + total);
    if (read === 0) break;
    total += read;
  }
  return total;
}

/**
 * Record where the log stands now. A missing file marks offset 0, so a log that
 * appears later is read from its start. An unterminated last line is still being
 * written, so it stays inside the window and is read whole once it completes.
 */
export function markLog(file: string): LogMark {
  if (!existsSync(file)) return { offset: 0, fingerprint: Buffer.alloc(0) };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LOG_MARK_FINGERPRINT_BYTES);
    const tail = Buffer.alloc(size - start);
    const read = readFully(fd, tail, start);
    const lastNewline = tail.subarray(0, read).lastIndexOf(0x0a);
    const keep = lastNewline >= 0 ? lastNewline + 1 : (start === 0 ? 0 : read);
    return { offset: start + keep, fingerprint: Buffer.from(tail.subarray(0, keep)) };
  } finally {
    closeSync(fd);
  }
}

function continuesFromMark(fd: number, mark: LogMark): boolean {
  if (fstatSync(fd).size < mark.offset) return false;
  if (mark.fingerprint.length === 0) return true;
  const before = Buffer.alloc(mark.fingerprint.length);
  const read = readFully(fd, before, mark.offset - mark.fingerprint.length);
  return read === before.length && before.equals(mark.fingerprint);
}

/** The text written after `mark`, or the whole file when the log no longer continues from it. */
export function readLogSince(file: string, mark: LogMark): LogWindow {
  if (!existsSync(file)) return { text: '', rotated: mark.offset > 0 };
  const fd = openSync(file, 'r');
  try {
    const rotated = !continuesFromMark(fd, mark);
    const from = rotated ? 0 : mark.offset;
    const window = Buffer.alloc(Math.max(0, fstatSync(fd).size - from));
    const read = readFully(fd, window, from);
    return { text: window.subarray(0, read).toString('utf8'), rotated };
  } finally {
    closeSync(fd);
  }
}

/**
 * Lines of the window after `mark` that match any pattern. Patterns must not
 * carry the `g` or `y` flag: `test` on those is stateful across lines.
 */
export function matchingLinesSince(
  file: string,
  mark: LogMark,
  patterns: readonly RegExp[],
): MatchedLogLines {
  const { text, rotated } = readLogSince(file, mark);
  return {
    lines: text.split('\n').filter((line) => patterns.some((pattern) => pattern.test(line))),
    rotated,
  };
}
