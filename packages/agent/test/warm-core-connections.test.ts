import { describe, it, expect } from 'vitest';
import {
  selectWarmCoreCandidates,
  reconcileWarmCoreConnections,
  type WarmCoreAgent,
  type WarmCoreDeps,
} from '../src/p2p/warm-core-connections.js';

describe('selectWarmCoreCandidates', () => {
  it('keeps only nodeRole=core, drops self, dedupes, preserves order', () => {
    const agents: WarmCoreAgent[] = [
      { peerId: 'edge1', nodeRole: 'edge' },
      { peerId: 'core1', nodeRole: 'core' },
      { peerId: 'self', nodeRole: 'core' },
      { peerId: 'core2', nodeRole: 'core' },
      { peerId: 'core1', nodeRole: 'core' }, // dup
      { peerId: 'noRole' },
    ];
    expect(selectWarmCoreCandidates(agents, 'self').map((a) => a.peerId)).toEqual([
      'core1',
      'core2',
    ]);
  });

  it('returns empty when there are no cores', () => {
    expect(selectWarmCoreCandidates([{ peerId: 'e', nodeRole: 'edge' }], 'self')).toEqual([]);
  });

  it('ranks freshest-first by lastSeen; unknown freshness sorts last (stable)', () => {
    const now = Date.parse('2026-06-02T00:00:00Z');
    const agents: WarmCoreAgent[] = [
      { peerId: 'old', nodeRole: 'core', lastSeen: '2026-06-01T06:00:00Z' },
      { peerId: 'noTs', nodeRole: 'core' }, // unknown freshness
      { peerId: 'fresh', nodeRole: 'core', lastSeen: '2026-06-01T23:00:00Z' },
    ];
    expect(
      selectWarmCoreCandidates(agents, 'self', {
        nowMs: now,
        staleThresholdMs: 24 * 60 * 60 * 1000,
      }).map((a) => a.peerId),
    ).toEqual(['fresh', 'old', 'noTs']);
  });

  it('drops cores staler than the threshold but keeps those without a lastSeen', () => {
    const now = Date.parse('2026-06-02T00:00:00Z');
    const agents: WarmCoreAgent[] = [
      { peerId: 'stale', nodeRole: 'core', lastSeen: '2026-05-01T00:00:00Z' }, // ~1mo old
      { peerId: 'noTs', nodeRole: 'core' },
      { peerId: 'fresh', nodeRole: 'core', lastSeen: '2026-06-01T23:00:00Z' },
    ];
    expect(
      selectWarmCoreCandidates(agents, 'self', {
        nowMs: now,
        staleThresholdMs: 24 * 60 * 60 * 1000,
      }).map((a) => a.peerId),
    ).toEqual(['fresh', 'noTs']);
  });
});

/** Build deps with sensible spies; override per test. */
function makeDeps(overrides: Partial<WarmCoreDeps> = {}): {
  deps: WarmCoreDeps;
  dialed: string[];
  pinned: string[];
  unpinned: string[];
} {
  const dialed: string[] = [];
  const pinned: string[] = [];
  const unpinned: string[] = [];
  const deps: WarmCoreDeps = {
    selfPeerId: 'self',
    maxCores: 8,
    findCoreAgents: async () => [
      { peerId: 'core1', nodeRole: 'core', agentAddress: '0x1' },
      { peerId: 'core2', nodeRole: 'core', agentAddress: '0x2' },
      { peerId: 'edge1', nodeRole: 'edge', agentAddress: '0x3' },
    ],
    isShardingTableCore: async () => true,
    isConnected: () => false,
    pin: async (peerId) => {
      pinned.push(peerId);
    },
    unpin: async (peerId) => {
      unpinned.push(peerId);
    },
    dial: async (peerId) => {
      dialed.push(peerId);
      return true;
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, dialed, pinned, unpinned };
}

describe('reconcileWarmCoreConnections', () => {
  it('pins + dials all gated cores when none are connected', async () => {
    const { deps, dialed, pinned } = makeDeps();
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ candidates: 2, pinned: 2, dialed: 2, skippedGate: 0, unpinned: 0 });
    expect(dialed).toEqual(['core1', 'core2']);
    expect(pinned).toEqual(['core1', 'core2']);
  });

  it('skips cores that fail the ShardingTable gate', async () => {
    const { deps, dialed } = makeDeps({
      isShardingTableCore: async (addr) => addr === '0x1',
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 1, dialed: 1, skippedGate: 1 });
    expect(dialed).toEqual(['core1']);
  });

  it('still pins (tags) an already-connected core, but does not redial it', async () => {
    // Regression: a connected core MUST be tagged keep-alive so libp2p
    // auto-redials it after a disconnect — the old `continue` skipped pinning.
    const { deps, dialed, pinned } = makeDeps({ isConnected: (id) => id === 'core1' });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 1 });
    expect(pinned).toEqual(['core1', 'core2']); // both tagged
    expect(dialed).toEqual(['core2']); // only the disconnected one dialed
  });

  it('honors the maxCores cap, counting only gated cores', async () => {
    const { deps, dialed } = makeDeps({
      maxCores: 1,
      findCoreAgents: async () => [
        { peerId: 'core1', nodeRole: 'core', agentAddress: '0x1' },
        { peerId: 'core2', nodeRole: 'core', agentAddress: '0x2' },
        { peerId: 'core3', nodeRole: 'core', agentAddress: '0x3' },
      ],
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res.pinned).toBe(1);
    expect(dialed).toEqual(['core1']);
  });

  it('treats a throwing gate as a denial (does not pin)', async () => {
    const { deps, dialed } = makeDeps({
      isShardingTableCore: async () => {
        throw new Error('rpc down');
      },
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 0, dialed: 0, skippedGate: 2 });
    expect(dialed).toEqual([]);
  });

  it('counts a failed dial as pinned-but-not-dialed', async () => {
    const { deps } = makeDeps({ dial: async () => false });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 0 });
  });

  it('does not consume a slot for a core whose pin throws; frees it for the next', async () => {
    // Regression: a pin failure (malformed peerId / peerStore.merge error) must
    // not be counted as pinned or eat a maxCores slot — a healthy core takes it.
    const localPinned: string[] = [];
    const { deps, dialed } = makeDeps({
      maxCores: 2,
      findCoreAgents: async () => [
        { peerId: 'bad', nodeRole: 'core', agentAddress: '0x1' },
        { peerId: 'core2', nodeRole: 'core', agentAddress: '0x2' },
        { peerId: 'core3', nodeRole: 'core', agentAddress: '0x3' },
      ],
      pin: async (peerId) => {
        if (peerId === 'bad') throw new Error('peerStore.merge failed');
        localPinned.push(peerId);
      },
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res.pinned).toBe(2); // 'bad' not counted; core2 + core3 fill the 2 slots
    expect(localPinned).toEqual(['core2', 'core3']);
    expect(dialed).toEqual(['core2', 'core3']); // 'bad' never dialed
    expect([...res.warmed].sort()).toEqual(['core2', 'core3']);
  });

  it('unpins cores that were warm last pass but are no longer selected', async () => {
    // Regression: the keep-alive tag must be removed when a core drops out of
    // the candidate/gated set, else pins leak and drift above maxCores.
    const { deps, unpinned } = makeDeps({
      previouslyWarmed: new Set(['core1', 'core2', 'gone1', 'gone2']),
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res.pinned).toBe(2);
    expect(res.unpinned).toBe(2);
    expect(unpinned.sort()).toEqual(['gone1', 'gone2']);
    // the returned warmed set is what the caller carries into the next pass
    expect([...res.warmed].sort()).toEqual(['core1', 'core2']);
  });

  it('unpins a core that newly fails the gate (cap-drift guard)', async () => {
    const { deps, unpinned } = makeDeps({
      previouslyWarmed: new Set(['core1', 'core2']),
      isShardingTableCore: async (addr) => addr === '0x1', // core2 now ungated
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 1, skippedGate: 1, unpinned: 1 });
    expect(unpinned).toEqual(['core2']);
  });

  it('#8 — a FAILED unpin is not counted and the peer is retained for a retry', async () => {
    // A failed unpin() means the keep-alive tag may still be set. Counting it
    // as unpinned AND forgetting the peer would leak a pin we can never reclaim
    // (it's gone from previouslyWarmed next tick). The peer must be carried in
    // `warmed` so the next pass retries the unpin, and the unpinned counter must
    // reflect only the successful removals.
    let calls = 0;
    const { deps } = makeDeps({
      previouslyWarmed: new Set(['core1', 'core2', 'flaky', 'gone']),
      unpin: async (peerId) => {
        calls += 1;
        if (peerId === 'flaky') throw new Error('peerStore busy');
      },
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(calls).toBe(2);                 // both non-selected peers attempted
    expect(res.unpinned).toBe(1);          // only 'gone' succeeded
    // 'flaky' is carried forward (still pinned) alongside the re-selected cores.
    expect([...res.warmed].sort()).toEqual(['core1', 'core2', 'flaky']);
  });
});
