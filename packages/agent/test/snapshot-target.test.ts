import { describe, expect, it } from 'vitest';
import { parseSnapshotTarget } from '../src/sync/snapshot-target.js';

const GRAPH = 'did:dkg:context-graph:cg/_shared_memory_snapshots/_/op/ka';

describe('parseSnapshotTarget', () => {
  it('uses the explicit graph-backed target', () => {
    expect(parseSnapshotTarget({ snapshotGraph: GRAPH })).toEqual({
      kind: 'graphBacked',
      graph: GRAPH,
    });
  });

  it('keeps content-addressed snapshot refs distinct from graph targets', () => {
    expect(parseSnapshotTarget({ snapshotRef: 'sha256:abc' })).toEqual({
      kind: 'storeRef',
      ref: 'sha256:abc',
    });
  });

  it('accepts legacy URI-shaped snapshot refs during rolling upgrades', () => {
    expect(parseSnapshotTarget({ snapshotRef: GRAPH })).toEqual({
      kind: 'graphBacked',
      graph: GRAPH,
    });
  });

  it('rejects conflicting explicit and legacy targets', () => {
    expect(parseSnapshotTarget({
      snapshotGraph: GRAPH,
      snapshotRef: 'sha256:different',
    })).toBeUndefined();
  });
});
