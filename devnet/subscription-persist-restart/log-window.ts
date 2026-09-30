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
 * The window always starts on a line boundary. The daemon may be in the middle
 * of a line when the mark is taken, and the beginning of that line (where a
 * failure prefix such as "Failed to persist ..." lives) must stay inside the
 * window, however long the line already is. `markLog` therefore finds the start
 * of an unterminated last line by scanning backward from the end of the file for
 * the newline before it, in bounded chunks, and never advances the mark past it.
 * When no newline lies within {@link LOG_MARK_MAX_LINE_SCAN_BYTES} of the end (or
 * the file has none), the mark falls back to offset 0 and the whole file is the
 * window: again only over-reporting, never hiding a line.
 *
 * Offsets are bytes, never string indices: the log contains multi-byte
 * characters, so a character index into decoded text is not a file offset. The
 * backward scan works on bytes too: 0x0a never occurs inside a multi-byte UTF-8
 * sequence, so a chunk boundary that splits a character cannot fake a line start.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/** How many bytes before the mark must still match for the log to count as continuous. */
export const LOG_MARK_FINGERPRINT_BYTES = 4096;

/** How much of the end of the log one step of the backward line-start scan reads. */
export const LOG_MARK_SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * How far back from the end of the log `markLog` looks for the newline before an
 * unterminated last line: a line still being written, up to 1 MiB long, is found;
 * a longer one (or a log with no newline in that range) makes the mark fall back
 * to the start of the file. The bound keeps marking cheap however large the log
 * is (a few reads, never a scan of a 50 MiB file), and 1 MiB is far beyond any
 * line the daemon's logger writes (an error with its stack is a few KiB). Falling
 * back can only over-report, so the bound trades a possible false alarm on a
 * pathological line for a mark that stays O(bound).
 */
export const LOG_MARK_MAX_LINE_SCAN_BYTES = 1024 * 1024;

export interface LogMark {
  /** Byte offset where the window starts: just past the last complete line at mark time (0: the whole file). */
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
 * Byte offset just past the last newline of the first `size` bytes of the file,
 * i.e. where the last (possibly unterminated) line starts; `size` itself when the
 * file ends on a newline. Scans backward from `size` in chunks and looks at most
 * {@link LOG_MARK_MAX_LINE_SCAN_BYTES} back. Returns 0 when there is no newline in
 * that range or the file is shorter than `size` (it changed underneath us): the
 * window is then the whole file, which can over-report but never hides a line.
 */
function startOfLastLine(fd: number, size: number): number {
  const floor = Math.max(0, size - LOG_MARK_MAX_LINE_SCAN_BYTES);
  let end = size;
  while (end > floor) {
    const start = Math.max(floor, end - LOG_MARK_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    if (readFully(fd, chunk, start) !== chunk.length) return 0;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

/**
 * Record where the log stands now: just past its last complete line, so an
 * unterminated last line is still being written and stays inside the window, read
 * whole once it completes, however long it already is (see the file header). A
 * missing file marks offset 0, so a log that appears later is read from its start.
 */
export function markLog(file: string): LogMark {
  const whole: LogMark = { offset: 0, fingerprint: Buffer.alloc(0) };
  if (!existsSync(file)) return whole;
  const fd = openSync(file, 'r');
  try {
    const offset = startOfLastLine(fd, fstatSync(fd).size);
    const from = Math.max(0, offset - LOG_MARK_FINGERPRINT_BYTES);
    const fingerprint = Buffer.alloc(offset - from);
    if (readFully(fd, fingerprint, from) !== fingerprint.length) return whole;
    return { offset, fingerprint };
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
