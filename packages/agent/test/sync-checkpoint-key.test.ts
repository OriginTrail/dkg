import { describe, it, expect } from 'vitest';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';

describe('getSyncCheckpointKey', () => {
  it('keeps an unscoped key when no sinceBatchId is given', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', false, 'data')).toBe(
      'peerA|mfacts|durable|data',
    );
  });

  it('distinguishes shared-memory from durable fetches', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', true, 'data')).toBe(
      'peerA|mfacts|swm|data',
    );
  });

  it('appends the snapshotRef only for the snapshot phase', () => {
    expect(getSyncCheckpointKey('peerA', 'mfacts', false, 'snapshot', 'ref-1')).toBe(
      'peerA|mfacts|durable|snapshot|ref-1',
    );
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
    expect(delta7).not.toBe(delta9);
  });
});
