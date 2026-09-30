/**
 * No-devnet tests for the recovery check of the swm-host-store-durability suite
 * (`log-frames.ts`). They pin, at the assertion level, what the live kill -9
 * cycles are allowed to accept.
 */
import { describe, expect, it } from 'vitest';
import { HEADER_BYTES, checkNoSeqnoReuse, parseLog, type LogFrame } from './log-frames.js';

/** A frame as the store lays it out on disk: header (timestamp, seqno, length) then the ciphertext. */
function frameBytes(seqno: number, fill: number, timestampMs = 1_700_000_000_000 + seqno, length = 8): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeBigUInt64BE(BigInt(timestampMs), 0);
  header.writeBigUInt64BE(BigInt(seqno), 8);
  header.writeUInt32BE(length, 16);
  return Buffer.concat([header, Buffer.alloc(length, fill)]);
}

/** Frames of a log holding `seqnos`, each filled with its own seqno unless `variant` says otherwise. */
function framesOf(seqnos: number[], variant: Record<number, number> = {}): LogFrame[] {
  const buf = Buffer.concat(seqnos.map((s, i) => frameBytes(s, variant[i] ?? s)));
  return parseLog(buf).frames;
}

/** The assertion this check replaces (devnet suite before the fix), for the regression case below. */
function legacyAssertionPasses(seqnos: number[], maxSeqnoEver: number): boolean {
  const sortedUnique =
    new Set(seqnos).size === seqnos.length && seqnos.every((s, i) => i === 0 || seqnos[i - 1]! < s);
  const fresh = seqnos.filter((s) => s > maxSeqnoEver);
  if (!sortedUnique || fresh.length === 0) return false;
  const suffix = seqnos.slice(seqnos.indexOf(fresh[0]!));
  return suffix.length === fresh.length && suffix.every((s, i) => s === fresh[i]);
}

describe('parseLog', () => {
  it('returns the complete frames with a digest of each whole frame and stops at a torn tail', () => {
    const complete = Buffer.concat([frameBytes(1, 1), frameBytes(2, 2)]);
    const torn = frameBytes(3, 3).subarray(0, HEADER_BYTES + 3);
    const parsed = parseLog(Buffer.concat([complete, torn]));
    expect(parsed.frames.map((f) => f.seqno)).toEqual([1, 2]);
    expect(parsed.validLength).toBe(complete.length);
    expect(parsed.size).toBe(complete.length + torn.length);
    expect(parsed.frames[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.frames[0]!.digest).not.toBe(parsed.frames[1]!.digest);
  });

  it('a different ciphertext, or a different header for the same seqno, changes the digest', () => {
    const base = parseLog(frameBytes(4, 4)).frames[0]!;
    expect(parseLog(frameBytes(4, 9)).frames[0]!.digest).not.toBe(base.digest);
    expect(parseLog(frameBytes(4, 4, 42)).frames[0]!.digest).not.toBe(base.digest);
    expect(parseLog(frameBytes(4, 4)).frames[0]!.digest).toBe(base.digest);
  });

  it('an empty log has no frames', () => {
    expect(parseLog(Buffer.alloc(0))).toEqual({ size: 0, validLength: 0, frames: [] });
  });
});

describe('checkNoSeqnoReuse', () => {
  const atKill = (seqnos: number[], metaSeqno: number | null) => ({ frames: framesOf(seqnos), metaSeqno });

  it('accepts the honest recovery: the frame complete at the kill is kept and the next one takes seqno 5', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 3),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 5]) },
    });
    expect(result.violations).toEqual([]);
    expect(result.highWater).toBe(4);
    expect(result.newFrames.map((f) => f.seqno)).toEqual([5]);
  });

  it('accepts several new frames and a cursor that was ahead of the log at the kill', () => {
    // meta 5 but only frames 1..3 complete: the next frames must clear 5.
    expect(
      checkNoSeqnoReuse({ atKill: atKill([1, 2, 3], 5), afterRestart: { frames: framesOf([1, 2, 3, 6, 7]) } }).violations,
    ).toEqual([]);
    expect(
      checkNoSeqnoReuse({ atKill: atKill([1, 2, 3], null), afterRestart: { frames: framesOf([1, 2, 3, 4]) } }).violations,
    ).toEqual([]);
    expect(
      checkNoSeqnoReuse({ atKill: atKill([], null), afterRestart: { frames: framesOf([1, 2]) } }).violations,
    ).toEqual([]);
  });

  it('REGRESSION (review of the suite): dropping complete frame 4 and appending different frames 4 and 5 fails', () => {
    const before = [1, 2, 3, 4];
    // Recovery dropped frame 4, then appended a DIFFERENT frame 4 and a frame 5.
    const recovered = framesOf([1, 2, 3, 4, 5], { 3: 99, 4: 98 });

    // The assertion this check replaces was satisfied by it: high-water mark max(meta 3, last frame 4) = 4;
    // the log is sorted and unique, and the "fresh" suffix above the mark is [5].
    expect(legacyAssertionPasses([1, 2, 3, 4, 5], 4)).toBe(true);

    const result = checkNoSeqnoReuse({ atKill: atKill(before, 3), afterRestart: { frames: recovered } });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/frame seqno 4 was replaced in place/);
  });

  it('fails when a complete frame is dropped and the new frames start above it', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 3),
      afterRestart: { frames: framesOf([1, 2, 3, 5, 6]) },
    });
    expect(result.violations.join('\n')).toMatch(/frame #4 was seqno 4 at the kill but is seqno 5/);
  });

  it('fails when a frame in the preserved prefix is replaced in place', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 5], { 2: 77 }) },
    });
    expect(result.violations).toEqual(['frame seqno 3 was replaced in place: its bytes changed across the crash']);
  });

  it('fails when a frame of the prefix is dropped (the head of the log)', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([2, 3, 4, 5, 6]) },
    });
    expect(result.violations.join('\n')).toMatch(/frame #1 was seqno 1 at the kill but is seqno 2/);
  });

  it('fails when the recovered log lost the tail of the frames that were complete at the kill', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 2, 3]) },
    });
    expect(result.violations[0]).toMatch(/complete frame #4 \(seqno 4\).*missing.*only 3 of the 4/);
  });

  it('fails when the prefix is reordered', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 3, 2, 4, 5]) },
    });
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('fails when a frame appended after the restart reuses a seqno at or below the high-water mark', () => {
    // The prefix is intact, but the next frame took seqno 4 again.
    const reusedLast = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 3),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 4], { 4: 55 }) },
    });
    expect(reusedLast.violations.join('\n')).toMatch(/seqno 4 was appended after the restart .* high-water mark 4: a seqno was reused/);

    // A durable cursor ahead of the log (meta 5, frames up to 3): seqno 5 is taken too.
    const reusedCursor = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3], 5),
      afterRestart: { frames: framesOf([1, 2, 3, 5]) },
    });
    expect(reusedCursor.violations.join('\n')).toMatch(/seqno 5 was appended after the restart .* high-water mark 5/);
    expect(checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3], 5),
      afterRestart: { frames: framesOf([1, 2, 3, 6]) },
    }).violations).toEqual([]);
  });

  it('fails on a duplicate or out-of-order seqno among the new frames', () => {
    const duplicate = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 5, 5], { 5: 60 }) },
    });
    expect(duplicate.violations.join('\n')).toMatch(/seqno 5 .* not strictly above the previous new frame 5/);

    const outOfOrder = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 6, 5]) },
    });
    expect(outOfOrder.violations.join('\n')).toMatch(/seqno 5 .* not strictly above the previous new frame 6/);
  });

  it('fails when nothing was appended after the restart, unless the caller says that is fine', () => {
    const input = { atKill: atKill([1, 2, 3, 4], 4), afterRestart: { frames: framesOf([1, 2, 3, 4]) } };
    expect(checkNoSeqnoReuse(input).violations.join('\n')).toMatch(/no frame was appended after the restart/);
    expect(checkNoSeqnoReuse({ ...input, requireNewFrames: false }).violations).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const result = checkNoSeqnoReuse({
      atKill: atKill([1, 2, 3, 4], 4),
      afterRestart: { frames: framesOf([1, 2, 3, 4, 4], { 1: 70, 4: 71 }) },
    });
    expect(result.violations).toHaveLength(2);
  });
});
