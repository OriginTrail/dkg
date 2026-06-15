import { describe, it, expect } from 'vitest';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';

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

  // R10 — member SWM recovery must get its OWN cursor namespace so it never
  // overwrites or deletes the shared incremental-sync cursor.
  it('scopes the key with a |recovery segment distinct from the normal SWM key', () => {
    const normal = getSyncCheckpointKey('peerA', 'mfacts', true, 'data');
    const recovery = getSyncCheckpointKey('peerA', 'mfacts', true, 'data', undefined, undefined, true);

    expect(normal).toBe('peerA|mfacts|swm|data');
    expect(recovery).toBe('peerA|mfacts|swm|data|recovery');
    expect(recovery).not.toBe(normal);
  });

  it('R10 invariant: a recovery run never mutates the shared incremental-sync cursor', () => {
    const store = new MemorySyncCheckpointStore();
    const normalKey = getSyncCheckpointKey('peerA', 'mfacts', true, 'data');
    const recoveryKey = getSyncCheckpointKey('peerA', 'mfacts', true, 'data', undefined, undefined, true);

    // Background incremental sync has advanced its cursor.
    store.set(normalKey, 42);

    // A recovery run sets and then drops its OWN cursor (mid-stream set, then
    // the all-or-nothing partial-fetch deleteCheckpoint), as the recovery path
    // does per page.
    store.set(recoveryKey, 100);
    store.delete(recoveryKey);

    // The shared incremental cursor is untouched — incremental sync resumes at
    // 42, not restarted from 0.
    expect(store.get(normalKey)?.offset).toBe(42);
    expect(store.get(recoveryKey)).toBeUndefined();
  });
});
