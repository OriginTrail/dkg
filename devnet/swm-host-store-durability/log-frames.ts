/**
 * Pure helpers for the swm-host-store-durability devnet suite: parse a
 * `SwmHostModeStore` log into frames, decide from a snapshot taken at the
 * kill whether the recovery preserved every complete frame and never reused a
 * seqno, decide whether the `.meta` cursor covers the log (exactly, once it has
 * stopped growing; allowing the one append in flight, while it still grows),
 * decide whether host catch-up served exactly the frames on disk, account for a
 * catch-up walk (page by page, so one full response followed by an empty one
 * cannot pass for continuation), and decide when a log has been quiet for long
 * enough.
 * No devnet, no I/O: covered by `log-frames.test.ts`.
 *
 * On-disk frame (see `packages/agent/src/swm/host-mode-store.ts`):
 *   [8-byte BE timestampMs] [8-byte BE seqno] [4-byte BE len] [len bytes]
 */
import { createHash } from 'node:crypto';

export const HEADER_BYTES = 20;

export interface LogFrame {
  seqno: number;
  /** sha256 (hex) of the whole frame as stored: header (timestamp, seqno, length) and ciphertext. */
  digest: string;
  /** sha256 (hex) of the ciphertext alone: what host catch-up serves as the envelope. */
  envelopeSha256: string;
}

export interface ParsedLog {
  /** Bytes on disk. */
  size: number;
  /** Offset just past the last complete frame; anything after it is a torn tail. */
  validLength: number;
  /** Complete frames, in file order. */
  frames: LogFrame[];
}

/** Walk the frames of a log the way the store does; a torn tail is not a frame. */
export function parseLog(buf: Buffer): ParsedLog {
  const frames: LogFrame[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + HEADER_BYTES + len;
    if (end > buf.length) break;
    frames.push({
      seqno: Number(buf.readBigUInt64BE(offset + 8)),
      digest: createHash('sha256').update(buf.subarray(offset, end)).digest('hex'),
      envelopeSha256: createHash('sha256').update(buf.subarray(offset + HEADER_BYTES, end)).digest('hex'),
    });
    offset = end;
  }
  return { size: buf.length, validLength: offset, frames };
}

export interface RecoveryCheckInput {
  /**
   * What was on disk once the killed daemon was gone: its complete frames (in
   * file order) and the `.meta` cursor (`null` when the meta was absent or torn).
   */
  atKill: { frames: readonly LogFrame[]; metaSeqno: number | null };
  /** The complete frames of the log after the restart and the frames appended since. */
  afterRestart: { frames: readonly LogFrame[] };
  /**
   * Require at least one frame appended after the restart. The live suite waits
   * for one before it checks, so a recovered log with nothing new is a failure
   * of the run, not a vacuous pass. Default `true`.
   */
  requireNewFrames?: boolean;
}

export interface RecoveryCheckResult {
  /** max(meta cursor, last complete frame) at the kill: no later frame may carry a seqno at or below it. */
  highWater: number;
  /** Frames after the preserved prefix, i.e. the ones appended since the restart. */
  newFrames: LogFrame[];
  /** Human-readable failures; empty means the recovery held. */
  violations: string[];
}

/**
 * Check a recovery against the snapshot taken at the kill.
 *
 *  (a) The recovered log starts with exactly the complete frames that were on
 *      disk at the kill: none dropped, replaced (same seqno, different bytes),
 *      or reordered. A recovery that drops frame 4 and then appends different
 *      frames 4 and 5 fails here even though the result looks sorted and unique.
 *  (b) Every frame after that prefix carries a seqno strictly above the
 *      high-water mark and strictly increasing, so a seqno is never reused.
 *
 * The caller must make sure the store's retention limits (TTL, byte cap) cannot
 * prune between the snapshot and the check; a legitimate prune would drop
 * prefix frames.
 */
export function checkNoSeqnoReuse(input: RecoveryCheckInput): RecoveryCheckResult {
  const { atKill, afterRestart } = input;
  const requireNewFrames = input.requireNewFrames ?? true;
  const violations: string[] = [];

  let lastComplete = 0;
  for (const frame of atKill.frames) lastComplete = Math.max(lastComplete, frame.seqno);
  const highWater = Math.max(atKill.metaSeqno ?? 0, lastComplete);

  const prefixLength = atKill.frames.length;
  for (let i = 0; i < prefixLength; i += 1) {
    const expected = atKill.frames[i]!;
    const actual = afterRestart.frames[i];
    if (!actual) {
      violations.push(
        `complete frame #${i + 1} (seqno ${expected.seqno}) and everything after it is missing: ` +
          `the recovered log has only ${afterRestart.frames.length} of the ${prefixLength} frames that were complete at the kill`,
      );
      break;
    }
    if (actual.seqno !== expected.seqno) {
      violations.push(
        `frame #${i + 1} was seqno ${expected.seqno} at the kill but is seqno ${actual.seqno} after recovery ` +
          '(a complete frame was dropped or reordered)',
      );
    } else if (actual.digest !== expected.digest) {
      violations.push(`frame seqno ${expected.seqno} was replaced in place: its bytes changed across the crash`);
    }
  }

  const newFrames = afterRestart.frames.slice(prefixLength);
  let previous = highWater;
  for (const frame of newFrames) {
    if (frame.seqno <= highWater) {
      violations.push(
        `seqno ${frame.seqno} was appended after the restart but is at or below the pre-kill high-water mark ${highWater}: a seqno was reused`,
      );
    } else if (frame.seqno <= previous) {
      violations.push(
        `seqno ${frame.seqno} was appended after the restart but is not strictly above the previous new frame ${previous}`,
      );
    }
    previous = Math.max(previous, frame.seqno);
  }
  if (requireNewFrames && newFrames.length === 0) {
    violations.push(`no frame was appended after the restart (high-water mark ${highWater}): nothing to check`);
  }

  return { highWater, newFrames, violations };
}

export interface CursorCoverageInput {
  /** The complete frames of the log (`parseLog(...).frames`), in file order. */
  frames: readonly LogFrame[];
  /** The `.meta` cursor read at the same moment (`null` when the meta is absent or torn). */
  metaSeqno: number | null;
  /**
   * `true` while a writer is still feeding the host: an append is fsynced frame
   * first and cursor second, so the cursor may trail by the ONE append that is in
   * flight and must still cover every complete frame but the newest. The default
   * (`false`) is the quiescent check: ingestion has stopped and drained.
   */
  appendInFlight?: boolean;
}

/**
 * Check that the `.meta` cursor covers the log.
 *
 * With ingestion stopped (the default) nothing is in flight: the cursor must be
 * readable and at or above the last complete frame, so a cursor that stays one
 * behind (log ending at seqno 10, cursor 9, every write finished) fails. While
 * frames are still arriving (`appendInFlight`) the cursor may trail the log by
 * the frame being appended, no more: "one frame" is counted in frames, not in
 * seqnos, so a seqno burned by a failed append neither widens nor narrows the
 * allowance. A cursor above the log is always fine (a frame lost before its
 * cursor leaves a gap, never a reuse).
 *
 * Returns human-readable failures; empty means the cursor covers the log.
 */
export function checkCursorCoversLog(input: CursorCoverageInput): string[] {
  const { frames, metaSeqno, appendInFlight = false } = input;
  if (frames.length === 0) return [];
  const highest = (list: readonly LogFrame[]) => list.reduce((high, frame) => Math.max(high, frame.seqno), 0);
  const lastComplete = highest(frames);
  const required = appendInFlight ? highest(frames.slice(0, -1)) : lastComplete;
  if (metaSeqno === null) {
    return [`the .meta cursor is absent or unreadable while the log holds ${frames.length} frames up to seqno ${lastComplete}`];
  }
  if (metaSeqno < required) {
    return [
      `the .meta cursor is ${metaSeqno} but the last complete frame is seqno ${lastComplete} and ` +
        (appendInFlight
          ? `at most one append can be in flight, so the cursor may trail only by that frame (it must reach ${required})`
          : 'nothing is being appended: the cursor of a finished append was not persisted'),
    ];
  }
  return [];
}

/** One envelope a host served during catch-up, as the daemon reports it with `includeEntries`. */
export interface ServedEntry {
  seqno: number;
  envelopeSha256: string;
}

/**
 * Check what host catch-up served, across all its pages and in the order it
 * arrived, against the frames the log holds after the starting cursor.
 *
 * Counts and a final cursor cannot show this: [1, 1, 3, 4] served for a log of
 * [1, 2, 3, 4] has the right count and the right last seqno. The served
 * sequence must be the expected frames exactly: none missing, none repeated,
 * none out of order, and each envelope byte-identical to the stored ciphertext.
 *
 * Returns human-readable failures; empty means catch-up served the log suffix.
 */
export function checkServedFrames(input: {
  expected: readonly LogFrame[];
  served: readonly ServedEntry[];
}): string[] {
  const { expected, served } = input;
  const violations: string[] = [];
  if (served.length !== expected.length) {
    violations.push(`catch-up served ${served.length} envelopes but the log holds ${expected.length} frames after the cursor`);
  }
  const shared = Math.min(served.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    const want = expected[i]!;
    const got = served[i]!;
    if (got.seqno !== want.seqno) {
      violations.push(
        `served envelope #${i + 1} is seqno ${got.seqno} but frame #${i + 1} after the cursor is seqno ${want.seqno} ` +
          '(a frame was skipped, repeated or reordered)',
      );
    } else if (got.envelopeSha256 !== want.envelopeSha256) {
      violations.push(`served envelope seqno ${got.seqno} is not the ciphertext stored for that frame`);
    }
  }
  return violations;
}

/** One observed `host-catchup` call: where it resumed, how many frames it served and the cursor it returned. */
export interface ObservedCatchupPage {
  since: number;
  fetched: number;
  nextSeqno: number;
}

export interface CatchupWalkInput {
  /** The cursor the walk started from. */
  start: number;
  /** The complete frames the log holds (`parseLog(...).frames`). */
  frames: readonly LogFrame[];
  /** The calls of the walk, in order, including the final empty one that ended it. */
  pages: readonly ObservedCatchupPage[];
  /** The page size every call asked for (`maxEntriesPerRound`). */
  pageSize: number;
  /** Also require at least this many nonempty responses (the live suite asks for 3 from cursor 0). */
  minNonemptyPages?: number;
}

/**
 * Account for a catch-up walk page by page. Aggregate counters cannot show that
 * a walk crossed a page boundary: one response that carries everything followed
 * by an empty one has the right total and the right final cursor. So each call
 * must resume exactly where the previous one stopped; a nonempty page holds at
 * most `pageSize` frames, advances the cursor, and its cursor jump covers exactly
 * as many frames on disk as it served (none skipped, none counted twice); an
 * empty page leaves the cursor alone and is the last call; the walk served every
 * frame above `start`, ended on the log's last seqno, and had exactly as many
 * nonempty pages as `pageSize` demands (`ceil(frames / pageSize)`, and at least
 * `minNonemptyPages` when given).
 *
 * Returns human-readable failures; empty means the walk crossed every page
 * boundary the log has. Which frames were served is `checkServedFrames`' job.
 */
export function checkCatchupWalk(input: CatchupWalkInput): string[] {
  const { start, frames, pages, pageSize } = input;
  const violations: string[] = [];
  const expected = frames.filter((frame) => frame.seqno > start);
  const lastSeqno = expected.at(-1)?.seqno ?? start;
  let cursor = start;
  let nonempty = 0;
  let fetchedTotal = 0;
  pages.forEach((page, index) => {
    const label = `call #${index + 1} (since ${page.since})`;
    if (page.since !== cursor) violations.push(`${label} did not resume at the previous cursor ${cursor}`);
    if (page.fetched === 0) {
      if (page.nextSeqno !== page.since) violations.push(`${label} served nothing but moved the cursor to ${page.nextSeqno}`);
      if (index !== pages.length - 1) violations.push(`${label} served nothing and the walk went on`);
    } else {
      nonempty += 1;
      fetchedTotal += page.fetched;
      if (page.fetched > pageSize) violations.push(`${label} served ${page.fetched} frames, above the page size ${pageSize}`);
      if (page.nextSeqno <= page.since) violations.push(`${label} served ${page.fetched} frames but did not advance the cursor`);
      const covered = frames.filter((frame) => frame.seqno > page.since && frame.seqno <= page.nextSeqno).length;
      if (covered !== page.fetched) {
        violations.push(`${label} served ${page.fetched} frames but its cursor ${page.nextSeqno} covers ${covered} frames on disk`);
      }
    }
    cursor = page.nextSeqno;
  });
  if (pages.length === 0 || pages[pages.length - 1]!.fetched !== 0) violations.push('the walk did not end on an empty response');
  if (fetchedTotal !== expected.length) violations.push(`the walk served ${fetchedTotal} frames but the log holds ${expected.length} above ${start}`);
  if (cursor !== lastSeqno) violations.push(`the walk ended at cursor ${cursor} but the log's last seqno above ${start} is ${lastSeqno}`);
  const exact = Math.ceil(expected.length / pageSize);
  if (nonempty !== exact) {
    violations.push(`the walk had ${nonempty} nonempty responses but pages of ${pageSize} over ${expected.length} frames make ${exact}`);
  }
  if (input.minNonemptyPages !== undefined && nonempty < input.minNonemptyPages) {
    violations.push(`the walk had ${nonempty} nonempty responses, fewer than the ${input.minNonemptyPages} that crossing a page boundary takes`);
  }
  return violations;
}

/**
 * Decide when a store has stopped changing: the returned probe is true only
 * once the same observation has been made over at least `quietMs`. The first
 * sight of an observation never counts as quiet and a change restarts the
 * interval, so a probe taken straight after an earlier read cannot pass before
 * any time has gone by.
 *
 * The observation is whatever the caller reads on each probe. The suite passes
 * the log size together with the `.meta` cursor: a frame is durable before its
 * cursor, so a log that has stopped growing can still have a cursor write on
 * its way.
 */
export function quietPeriodGate(quietMs: number): (observed: string | number, nowMs: number) => boolean {
  let last: string | number | undefined;
  let since = 0;
  return (observed, nowMs) => {
    if (observed !== last) {
      last = observed;
      since = nowMs;
      return false;
    }
    return nowMs - since >= quietMs;
  };
}
