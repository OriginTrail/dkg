/**
 * No-devnet tests for the recovery check of the swm-host-store-durability suite
 * (`log-frames.ts`). They pin, at the assertion level, what the live kill -9
 * cycles are allowed to accept.
 */
import { describe, expect, it } from 'vitest';
import {
  HEADER_BYTES,
  checkCatchupWalk,
  checkCursorCoversLog,
  checkNoSeqnoReuse,
  checkServedFrames,
  parseLog,
  quietPeriodGate,
  type LogFrame,
  type ObservedCatchupPage,
  type ServedEntry,
} from './log-frames.js';

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

describe('checkCursorCoversLog', () => {
  it('accepts a cursor at the last complete frame, and one ahead of it', () => {
    expect(checkCursorCoversLog({ frames: framesOf([1, 2, 3]), metaSeqno: 3 })).toEqual([]);
    expect(checkCursorCoversLog({ frames: framesOf([1, 2, 3]), metaSeqno: 5 })).toEqual([]);
  });

  it('REGRESSION (review of the suite): a cursor that stays one frame behind a quiescent log fails', () => {
    // The kill cycles allow the cursor to trail by the frame being appended.
    // That allowance accepts this log forever; the quiescent check does not.
    const seqnos = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(9, 'the in-flight allowance accepts it').toBeGreaterThanOrEqual(seqnos.at(-1)! - 1);
    expect(checkCursorCoversLog({ frames: framesOf(seqnos), metaSeqno: 9 }).join('\n'))
      .toMatch(/cursor is 9 but the last complete frame is seqno 10/);
  });

  it('while a writer is running the cursor may trail by the one append in flight, no more', () => {
    const frames = framesOf(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(checkCursorCoversLog({ frames, metaSeqno: 10, appendInFlight: true })).toEqual([]);
    expect(checkCursorCoversLog({ frames, metaSeqno: 9, appendInFlight: true }), 'the frame in flight').toEqual([]);
    expect(checkCursorCoversLog({ frames, metaSeqno: 8, appendInFlight: true }).join('\n'))
      .toMatch(/cursor is 8 .*at most one append can be in flight.*must reach 9/);
    expect(checkCursorCoversLog({ frames, metaSeqno: 9 }).join('\n'), 'the same cursor, once nothing is in flight').toMatch(/cursor is 9 /);
  });

  it('one frame is counted in frames, not seqnos: a burned seqno neither widens nor narrows the in-flight allowance', () => {
    // Seqno 9 was burned by a failed append: the log holds 8 and 10.
    const frames = framesOf([7, 8, 10]);
    // The cursor trails by the one frame in flight (seqno 10): it is 8, the frame before it.
    expect(checkCursorCoversLog({ frames, metaSeqno: 8, appendInFlight: true }), 'a seqno-based tail - 1 would reject it').toEqual([]);
    // Two frames behind is still too far, however small the seqno distance.
    expect(checkCursorCoversLog({ frames, metaSeqno: 7, appendInFlight: true }).join('\n')).toMatch(/must reach 8/);
  });

  it('a log whose only frame may be the one in flight has nothing to cover, but the cursor must still be readable', () => {
    expect(checkCursorCoversLog({ frames: framesOf([1]), metaSeqno: 0, appendInFlight: true })).toEqual([]);
    expect(checkCursorCoversLog({ frames: framesOf([1]), metaSeqno: null, appendInFlight: true }).join('\n')).toMatch(/absent or unreadable/);
  });

  it('fails when the cursor cannot be read', () => {
    expect(checkCursorCoversLog({ frames: framesOf([1, 2]), metaSeqno: null }).join('\n'))
      .toMatch(/absent or unreadable while the log holds 2 frames up to seqno 2/);
  });

  it('has nothing to cover in an empty log', () => {
    expect(checkCursorCoversLog({ frames: [], metaSeqno: null })).toEqual([]);
  });
});

describe('checkServedFrames', () => {
  const log = framesOf([1, 2, 3, 4]);
  const serve = (frames: readonly LogFrame[]): ServedEntry[] =>
    frames.map(({ seqno, envelopeSha256 }) => ({ seqno, envelopeSha256 }));

  it('accepts exactly the frames after the cursor, in order', () => {
    expect(checkServedFrames({ expected: log, served: serve(log) })).toEqual([]);
    expect(checkServedFrames({ expected: log.slice(2), served: serve(log.slice(2)) })).toEqual([]);
    expect(checkServedFrames({ expected: [], served: [] })).toEqual([]);
  });

  it('the envelope digest is of the ciphertext alone, not of the frame header', () => {
    const [sameCiphertext] = parseLog(frameBytes(1, 1, 42)).frames;
    expect(sameCiphertext!.envelopeSha256).toBe(log[0]!.envelopeSha256);
    expect(sameCiphertext!.digest).not.toBe(log[0]!.digest);
  });

  it('REGRESSION (review of the suite): [1, 1, 3, 4] has the right count and last seqno, and fails', () => {
    const served = serve([log[0]!, log[0]!, log[2]!, log[3]!]);
    expect(served).toHaveLength(log.length);
    expect(served.at(-1)!.seqno).toBe(log.at(-1)!.seqno);
    expect(checkServedFrames({ expected: log, served }).join('\n'))
      .toMatch(/served envelope #2 is seqno 1 but frame #2 after the cursor is seqno 2/);
  });

  it('fails when a frame is omitted', () => {
    const violations = checkServedFrames({ expected: log, served: serve([log[0]!, log[2]!, log[3]!]) }).join('\n');
    expect(violations).toMatch(/served 3 envelopes but the log holds 4 frames/);
    expect(violations).toMatch(/served envelope #2 is seqno 3 but frame #2 after the cursor is seqno 2/);
  });

  it('fails when an envelope is not the stored ciphertext', () => {
    const served = serve(log).map((entry) => (entry.seqno === 3 ? { ...entry, envelopeSha256: 'f'.repeat(64) } : entry));
    expect(checkServedFrames({ expected: log, served })).toEqual([
      'served envelope seqno 3 is not the ciphertext stored for that frame',
    ]);
  });

  it('fails when catch-up serves more than the log holds, or serves it out of order', () => {
    expect(checkServedFrames({ expected: log.slice(0, 2), served: serve(log) }).join('\n'))
      .toMatch(/served 4 envelopes but the log holds 2 frames/);
    expect(checkServedFrames({ expected: log, served: serve([log[1]!, log[0]!, log[2]!, log[3]!]) })).toHaveLength(2);
  });
});

describe('checkCatchupWalk', () => {
  const frames = framesOf([1, 2, 3, 4, 5, 6]);
  const page = (since: number, fetched: number, nextSeqno: number): ObservedCatchupPage => ({ since, fetched, nextSeqno });

  it('accepts a walk that continues from each truncated page to the end', () => {
    expect(checkCatchupWalk({
      start: 0, frames, pageSize: 2, minNonemptyPages: 3,
      pages: [page(0, 2, 2), page(2, 2, 4), page(4, 2, 6), page(6, 0, 6)],
    })).toEqual([]);
    // From the middle, with a short last page; and from the end, where the first call is already empty.
    expect(checkCatchupWalk({ start: 3, frames, pageSize: 2, pages: [page(3, 2, 5), page(5, 1, 6), page(6, 0, 6)] })).toEqual([]);
    expect(checkCatchupWalk({ start: 6, frames, pageSize: 2, pages: [page(6, 0, 6)] })).toEqual([]);
  });

  it('REGRESSION (review of the suite): one full response followed by an empty one never crosses a page boundary and fails', () => {
    const walk = [page(0, 6, 6), page(6, 0, 6)];
    // The totals and the final cursor are right, so counters alone pass it.
    expect(walk.reduce((sum, p) => sum + p.fetched, 0)).toBe(6);
    expect(walk.at(-1)!.nextSeqno).toBe(6);
    const violations = checkCatchupWalk({ start: 0, frames, pageSize: 2, minNonemptyPages: 2, pages: walk }).join('\n');
    expect(violations).toMatch(/served 6 frames, above the page size 2/);
    expect(violations).toMatch(/1 nonempty responses but pages of 2 over 6 frames make 3/);
    expect(violations).toMatch(/fewer than the 2 that crossing a page boundary takes/);
    // Even when the page size is the whole log, two nonempty responses can be demanded.
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 6, minNonemptyPages: 2, pages: walk }).join('\n'))
      .toMatch(/1 nonempty responses, fewer than the 2/);
  });

  it('fails when a call does not resume at the previous cursor', () => {
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 2, pages: [page(0, 2, 2), page(0, 2, 2), page(2, 2, 4), page(4, 2, 6), page(6, 0, 6)] }).join('\n'))
      .toMatch(/call #2 \(since 0\) did not resume at the previous cursor 2/);
  });

  it('fails when a cursor jump does not match the frames served (one skipped or counted twice)', () => {
    // [1, 1, 3, 4]: the second page says it served 2 frames and jumps to 4, over 3 frames on disk.
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 3, pages: [page(0, 3, 3), page(3, 2, 6), page(6, 0, 6)] }).join('\n'))
      .toMatch(/call #2 \(since 3\) served 2 frames but its cursor 6 covers 3 frames on disk/);
  });

  it('fails when a page does not advance the cursor, or an empty page moves it, or the walk goes on after an empty page', () => {
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 2, pages: [page(0, 2, 0), page(0, 0, 0)] }).join('\n'))
      .toMatch(/did not advance the cursor/);
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 2, pages: [page(0, 0, 2)] }).join('\n'))
      .toMatch(/served nothing but moved the cursor to 2/);
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 6, pages: [page(0, 0, 0), page(0, 6, 6), page(6, 0, 6)] }).join('\n'))
      .toMatch(/call #1 \(since 0\) served nothing and the walk went on/);
  });

  it('fails when the walk stops short, never ends on an empty response, or ends at the wrong cursor', () => {
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 2, pages: [page(0, 2, 2), page(2, 2, 4), page(4, 0, 4)] }).join('\n'))
      .toMatch(/served 4 frames but the log holds 6 above 0[\s\S]*ended at cursor 4 but the log's last seqno above 0 is 6/);
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 6, pages: [page(0, 6, 6)] }).join('\n'))
      .toMatch(/did not end on an empty response/);
    expect(checkCatchupWalk({ start: 0, frames, pageSize: 6, pages: [] }).join('\n')).toMatch(/did not end on an empty response/);
  });
});

describe('quietPeriodGate', () => {
  it('never passes on the first sight of a size, however the probe is timed', () => {
    const quiet = quietPeriodGate(6_000);
    expect(quiet(100, 0)).toBe(false);
    // The old gate compared a read with the one taken just before it and passed here.
    expect(quiet(100, 1)).toBe(false);
  });

  it('passes once the size has been unchanged for the whole interval', () => {
    const quiet = quietPeriodGate(6_000);
    expect(quiet(100, 0)).toBe(false);
    expect(quiet(100, 5_999)).toBe(false);
    expect(quiet(100, 6_000)).toBe(true);
  });

  it('REGRESSION (review of the suite): growth after the first probe restarts the interval', () => {
    const quiet = quietPeriodGate(6_000);
    expect(quiet(100, 0)).toBe(false);
    expect(quiet(100, 4_000)).toBe(false);
    // A pending delivery lands: the quiet time so far does not count.
    expect(quiet(140, 5_000)).toBe(false);
    expect(quiet(140, 10_999)).toBe(false);
    expect(quiet(140, 11_000)).toBe(true);
  });

  it('restarts on any change of size, a rewrite that shrinks the log included', () => {
    const quiet = quietPeriodGate(1_000);
    expect(quiet(100, 0)).toBe(false);
    expect(quiet(100, 1_000)).toBe(true);
    expect(quiet(60, 1_500)).toBe(false);
    expect(quiet(60, 2_500)).toBe(true);
  });

  it('REGRESSION (live run): a cursor written after its frame restarts the interval', () => {
    // Observed as "log size:cursor". The third frame is on disk, its cursor is not yet.
    const quiet = quietPeriodGate(6_000);
    expect(quiet('300:2', 0)).toBe(false);
    expect(quiet('300:2', 5_000)).toBe(false);
    // The log did not grow, but the cursor write landed.
    expect(quiet('300:3', 5_500)).toBe(false);
    expect(quiet('300:3', 11_499)).toBe(false);
    expect(quiet('300:3', 11_500)).toBe(true);
  });
});

