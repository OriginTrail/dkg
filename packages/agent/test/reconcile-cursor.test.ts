import { describe, it, expect } from 'vitest';
import {
  createCursorState,
  recordCompletion,
  absorbConfirmed,
  ordinalsToReconcile,
  type CursorState,
} from '../src/reconcile-cursor.js';

/**
 * Phase B — contiguous-watermark cursor correctness.
 *
 * These pin the two invariants the plan calls "critical": no gap is ever
 * skipped, and a reorg can't strand the watermark ahead of buried chain state.
 */

// Helper: complete an ordinal with no reorg gate (depth 0) at head 0.
function complete(state: CursorState, ordinal: number, block = 0): number {
  return recordCompletion(state, { ordinal, blockNumber: block }, block, 0);
}

describe('reconcile-cursor — contiguous watermark', () => {
  it('advances over a contiguous in-order run', () => {
    const s = createCursorState(0);
    expect(complete(s, 0)).toBe(1);
    expect(complete(s, 1)).toBe(2);
    expect(complete(s, 2)).toBe(3);
    expect(s.ahead.size).toBe(0);
  });

  it('does NOT skip a gap: 45 before 44 holds the watermark until 44 lands', () => {
    const s = createCursorState(44); // ordinals [0,44) already done
    // 45 completes first — watermark must stay at 44, not jump to 46.
    expect(complete(s, 45)).toBe(44);
    expect(s.ahead.has(45)).toBe(true);
    // 44 lands — now the run is contiguous and the watermark jumps to 46.
    expect(complete(s, 44)).toBe(46);
    expect(s.ahead.size).toBe(0);
  });

  it('absorbs a long out-of-order burst only once the bottom fills', () => {
    const s = createCursorState(10);
    complete(s, 13);
    complete(s, 11);
    complete(s, 14);
    expect(s.watermark).toBe(10); // 10 still missing
    expect(complete(s, 10)).toBe(12); // 10,11 contiguous; 12 missing
    expect(s.ahead.has(13)).toBe(true);
    expect(s.ahead.has(14)).toBe(true);
    expect(complete(s, 12)).toBe(15); // 12,13,14 absorbed
    expect(s.ahead.size).toBe(0);
  });

  it('ignores a duplicate/late completion below the watermark', () => {
    const s = createCursorState(5);
    expect(complete(s, 3)).toBe(5);
    expect(s.ahead.size).toBe(0);
  });
});

describe('reconcile-cursor — reorg confirmation depth', () => {
  const DEPTH = 5;

  it('holds the watermark until the ordinal is buried by confirmationDepth', () => {
    const s = createCursorState(0);
    // ordinal 0 registered at block 100, head only 102 → depth 2 < 5: hold.
    expect(recordCompletion(s, { ordinal: 0, blockNumber: 100 }, 102, DEPTH)).toBe(0);
    expect(s.ahead.has(0)).toBe(true);
    // head advances to 105 → depth 5 >= 5: absorb.
    expect(absorbConfirmed(s, 105, DEPTH)).toBe(1);
    expect(s.ahead.size).toBe(0);
  });

  it('a later sweep tick (higher head) absorbs depth-held ordinals without new completions', () => {
    const s = createCursorState(0);
    recordCompletion(s, { ordinal: 0, blockNumber: 100 }, 100, DEPTH);
    recordCompletion(s, { ordinal: 1, blockNumber: 101 }, 101, DEPTH);
    expect(s.watermark).toBe(0);
    // head buries 0 but not 1.
    expect(absorbConfirmed(s, 105, DEPTH)).toBe(1);
    // head buries 1 too.
    expect(absorbConfirmed(s, 106, DEPTH)).toBe(2);
  });

  it('depth gate + gap interact: a buried-but-non-contiguous ordinal still waits', () => {
    const s = createCursorState(0);
    // ordinal 1 buried deep, but 0 missing → watermark stays 0.
    expect(recordCompletion(s, { ordinal: 1, blockNumber: 1 }, 1000, DEPTH)).toBe(0);
    // ordinal 0 lands and is buried → both absorbed.
    expect(recordCompletion(s, { ordinal: 0, blockNumber: 1 }, 1000, DEPTH)).toBe(2);
  });

  it('depth <= 0 disables the reorg gate', () => {
    const s = createCursorState(0);
    expect(recordCompletion(s, { ordinal: 0, blockNumber: 100 }, 100, 0)).toBe(1);
  });
});

describe('reconcile-cursor — ordinalsToReconcile (sweep planning)', () => {
  it('returns [watermark, head) ascending', () => {
    const s = createCursorState(42);
    expect(ordinalsToReconcile(s, 47)).toEqual([42, 43, 44, 45, 46]);
  });

  it('skips ordinals already completed and waiting in ahead (avoids re-fetch)', () => {
    const s = createCursorState(42);
    // 44 already reconciled (held by depth/gap) — sweep should not re-fetch it.
    recordCompletion(s, { ordinal: 44, blockNumber: 1 }, 1, 100);
    expect(ordinalsToReconcile(s, 47)).toEqual([42, 43, 45, 46]);
  });

  it('returns empty when the watermark is at head', () => {
    const s = createCursorState(47);
    expect(ordinalsToReconcile(s, 47)).toEqual([]);
  });

  it('a failed fetch (never recorded) is retried on the next sweep', () => {
    const s = createCursorState(42);
    // Round 1: 43 fails (not recorded), 42/44 succeed but 42 holds nothing
    recordCompletion(s, { ordinal: 42, blockNumber: 1 }, 1, 0); // watermark -> 43
    recordCompletion(s, { ordinal: 44, blockNumber: 1 }, 1, 0); // held: 43 missing
    expect(s.watermark).toBe(43);
    // Next sweep still lists 43 (the gap), not 44.
    expect(ordinalsToReconcile(s, 45)).toEqual([43]);
    // 43 finally lands → watermark jumps past 44 too.
    expect(recordCompletion(s, { ordinal: 43, blockNumber: 1 }, 1, 0)).toBe(45);
  });
});
