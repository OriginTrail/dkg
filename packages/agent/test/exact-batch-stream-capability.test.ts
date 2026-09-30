import { describe, expect, it } from 'vitest';
import { exactBatchStreamUnsupported, rememberExactBatchStreamUnsupported, EXACT_BATCH_UNSUPPORTED_TTL_MS, EXACT_BATCH_UNSUPPORTED_MAX_PEERS } from '../src/sync/exact-batch-stream-capability.js';

describe('experimental exact stream unsupported transport hints', () => {
  it('suppresses only the captured current connection until the inclusive deadline', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', 'connection1', 'connection1', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection1', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS - 1)).toBe(true);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection1', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(false);
  });
  it('never transfers an old failure to a replacement connection or another owner', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', 'old', 'new', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'new', 100)).toBe(false);
    rememberExactBatchStreamUnsupported(owner, 'peer', 'old', 'old', 100);
    expect(exactBatchStreamUnsupported({}, 'peer', 'old', 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'new', 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'old', 100)).toBe(false);
  });
  it('clears disconnected evidence and ignores missing connection identity', () => {
    const owner = {};
    rememberExactBatchStreamUnsupported(owner, 'peer', null, null, 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', null, 100)).toBe(false);
    rememberExactBatchStreamUnsupported(owner, 'peer', 'connection', 'connection', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer', null, 100)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer', 'connection', 100)).toBe(false);
  });
  it('bounds each owner to an LRU set without refreshing expiry on reads', () => {
    const owner = {};
    for (let i = 0; i < EXACT_BATCH_UNSUPPORTED_MAX_PEERS; i++) rememberExactBatchStreamUnsupported(owner, `peer${i}`, 'c', 'c', 100);
    expect(exactBatchStreamUnsupported(owner, 'peer0', 'c', 101)).toBe(true);
    rememberExactBatchStreamUnsupported(owner, 'new', 'c', 'c', 101);
    expect(exactBatchStreamUnsupported(owner, 'peer1', 'c', 101)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'peer0', 'c', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(false);
    expect(exactBatchStreamUnsupported(owner, 'new', 'c', 100 + EXACT_BATCH_UNSUPPORTED_TTL_MS)).toBe(true);
  });
});
