import { describe, it, expect } from 'vitest';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';

/**
 * Phase C (#27) — the resume checkpoint key must be SCOPED by `sinceBatchId`.
 *
 * A delta fetch (`sinceBatchId` set) returns a different result set than a full
 * scan, so it must NOT resume at an offset recorded against a full scan (or a
 * delta with a different high-water mark) — that would skip newly eligible
 * triples. A full sync (no hint) keeps the unscoped key for backward compat.
 */
describe('getSyncCheckpointKey', () => {
  it('keeps an unscoped key when no sinceBatchId is given (backward compatible)', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', false, 'data')).toBe(
      'peerA|mfacts|durable|data',
    );
  });

  it('distinguishes workspace (SWM) from durable fetches', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', true, 'data')).toBe(
      'peerA|mfacts|swm|data',
    );
  });

  it('appends the snapshotRef only for the snapshot phase', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', false, 'snapshot', 'ref-1')).toBe(
      'peerA|mfacts|durable|snapshot|ref-1',
    );
    // snapshotRef is ignored for non-snapshot phases.
    expect(getSyncCheckpointKey('peerA', 'mfacts', false, 'data', 'ref-1')).toBe(
      'peerA|mfacts|durable|data',
    );
  });

  it('scopes the key by sinceBatchId so deltas never resume on a full-scan cursor', () => {
    const full = getSyncCheckpointKey('peerA', 'mfacts', false, 'data');
    const delta7 = getSyncCheckpointKey('peerA', 'mfacts', false, 'data', undefined, '7');
    const delta9 = getSyncCheckpointKey('peerA', 'mfacts', false, 'data', undefined, '9');

    expect(delta7).toBe('peerA|mfacts|durable|data|since:7');
    expect(delta7).not.toBe(full);
    expect(delta7).not.toBe(delta9); // different high-water marks → different cursors
  });
});
