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

  it('isolates exact VM batches from full sync and from each other', () => {
    const full = getSyncCheckpointKey('peerA', 'mfacts', false, 'data');
    const exactA = getSyncCheckpointKey(
      'peerA', 'mfacts', false, 'data', undefined, undefined, undefined, 'exact:a',
    );
    const exactB = getSyncCheckpointKey(
      'peerA', 'mfacts', false, 'data', undefined, undefined, undefined, 'exact:b',
    );

    expect(exactA).not.toBe(full);
    expect(exactB).not.toBe(full);
    expect(exactA).not.toBe(exactB);
  });

  it('isolates selected metadata continuation from the ordinary SWM cursor', () => {
    const ordinary = getSyncCheckpointKey('peerA', 'mfacts', true, 'meta');
    const selected = getSyncCheckpointKey(
      'peerA',
      'mfacts',
      true,
      'meta',
      undefined,
      undefined,
      undefined,
      undefined,
      'selected-swm-meta:test',
    );

    expect(selected).toBe('peerA|mfacts|swm|meta|requester:selected-swm-meta:test');
    expect(selected).not.toBe(ordinary);
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

describe('manifest-bound sync continuation', () => {
  const digestA = `sha256:${'aa'.repeat(32)}` as const;
  const digestB = `sha256:${'bb'.repeat(32)}` as const;
  const prefixDigest = `sha256:${'cc'.repeat(32)}` as const;

  it('stores offset, responder session and digest as one logical tuple', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setResponderSession('data', 'session-a', 10_000, 1_000, digestA);
    store.setManifestBoundOffset('data', 512, digestA, 1_001);

    expect(store.get('data', 1_002)).toMatchObject({
      offset: 512,
      manifestDigest: digestA,
      responderSessionId: 'session-a',
      responderSessionExpiresAtMs: 10_000,
    });
  });

  it('never carries a responder token across a manifest change', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setResponderSession('data', 'session-a', 10_000, 1_000, digestA);
    store.setManifestBoundOffset('data', 512, digestA, 1_001);
    store.setManifestBoundOffset('data', 0, digestB, 1_002);

    expect(store.get('data', 1_003)).toMatchObject({
      offset: 0,
      manifestDigest: digestB,
    });
    expect(store.get('data', 1_003)?.responderSessionId).toBeUndefined();
  });

  it('does not let an unbound offset update inherit a bound token or digest', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setResponderSession('data', 'session-a', 10_000, 1_000, digestA);
    store.setManifestBoundOffset('data', 512, digestA, 1_001);
    store.set('data', 768, 1_002);

    expect(store.get('data', 1_003)).toMatchObject({ offset: 768 });
    expect(store.get('data', 1_003)?.manifestDigest).toBeUndefined();
    expect(store.get('data', 1_003)?.responderSessionId).toBeUndefined();
  });

  it('preserves the digest when the responder session expires or is cleared', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setResponderSession('data', 'session-a', 2_000, 1_000, digestA);
    store.setManifestBoundOffset('data', 512, digestA, 1_001);

    expect(store.get('data', 2_001)).toMatchObject({
      offset: 512,
      manifestDigest: digestA,
    });
    expect(store.get('data', 2_001)?.responderSessionId).toBeUndefined();
  });

  it('atomically rebinds a proven prefix while dropping the old generation token', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setResponderSession('data', 'session-a', 10_000, 1_000, digestA);
    store.setManifestBoundOffset('data', 512, digestA, 1_001, prefixDigest);
    store.setManifestBoundOffset('data', 512, digestB, 1_002, prefixDigest);

    expect(store.get('data', 1_003)).toMatchObject({
      offset: 512,
      manifestDigest: digestB,
      manifestPrefixDigest: prefixDigest,
    });
    expect(store.get('data', 1_003)?.responderSessionId).toBeUndefined();
  });

  it('persists terminal verification with the manifest-bound full prefix', () => {
    const store = new MemorySyncCheckpointStore({ clock: () => 1_000 });
    store.setManifestBoundOffset('data', 6_357_721, digestA, 1_001, prefixDigest, true);

    expect(store.get('data', 1_002)).toMatchObject({
      offset: 6_357_721,
      manifestDigest: digestA,
      manifestPrefixDigest: prefixDigest,
      terminal: true,
    });

    store.setManifestBoundOffset('data', 512, digestB, 1_003, prefixDigest, false);
    expect(store.get('data', 1_004)?.terminal).toBeUndefined();
  });
});
