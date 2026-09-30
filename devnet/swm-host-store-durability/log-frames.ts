/**
 * Pure helpers for the swm-host-store-durability devnet suite: parse a
 * `SwmHostModeStore` log into frames, and decide from a snapshot taken at the
 * kill whether the recovery preserved every complete frame and never reused a
 * seqno. No devnet, no I/O: covered by `log-frames.test.ts`.
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
