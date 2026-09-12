import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import {
  runSyncOnConnect,
  runSelectedSharedMemoryRetry,
  type PeerSyncLease,
} from '@origintrail-official/dkg-agent/dist/sync/on-connect/sync-on-connect.js';
import { emptySharedMemorySyncResult } from '@origintrail-official/dkg-agent/dist/sync/shared-memory-diagnostics.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(kind: 'ordinary' | 'selected', syncingPeers: Set<string> | PeerSyncLease = new Set()) {
  const transfer = vi.fn(async () => 1);
  const context = {
    remotePeer: 'legacy-peer', syncingPeers,
    getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
    knownCorePeerIds: new Set<string>(),
    getSyncContextGraphs: () => ['legacy-cg'],
    getDurableSyncContextGraphs: () => ['legacy-cg'],
    syncFromPeer: transfer,
    refreshMetaSyncedFlags: vi.fn(async () => {}),
    discoverContextGraphsFromStore: vi.fn(async () => 0),
    logInfo: vi.fn(), onSyncAccounting: vi.fn(),
    selectedSharedMemoryLane: { admitWork: () => ({
      contextGraphIds: ['legacy-cg'],
      syncFromPeer: async () => ({
        kind: 'selected-shared-memory' as const,
        requestedScope: { kind: 'selected-public' as const, targets: [{ contextGraphId: 'legacy-cg', lane: 'selected-public' as const }] },
        scopeComplete: true, selectedScopeComplete: true,
        targetDiagnostics: { selectedPublic: { completed: 1, total: 1 }, ordinaryPrivate: { completed: 0, total: 0 } },
        shared: { ...emptySharedMemorySyncResult(), insertedTriples: await transfer(), completedPhases: 1 },
      }),
    }) },
  };
  return {
    context, transfer,
    run: (signal?: AbortSignal) => kind === 'ordinary'
      ? runSyncOnConnect({ ...context, ...(signal ? { signal } : {}) })
      : runSelectedSharedMemoryRetry({ ...context, ...(signal ? { signal } : {}) }),
  };
}

describe.each(['ordinary', 'selected'] as const)('published %s on-connect compatibility', kind => {
  it('executes a legacy Set caller without a signal and releases its peer', async () => {
    const peers = new Set<string>();
    const f = fixture(kind, peers);
    expect(await f.run()).toBe('synced');
    expect(f.transfer).toHaveBeenCalledOnce();
    expect(f.context.onSyncAccounting).toHaveBeenCalledOnce();
    expect(peers.size).toBe(0);
  });

  it('preserves an existing busy peer in the caller-owned Set', async () => {
    const peers = new Set(['legacy-peer']);
    const f = fixture(kind, peers);
    expect(await f.run()).toBe('already-syncing');
    expect(f.context.getPeerProtocols).not.toHaveBeenCalled();
    expect(peers.has('legacy-peer')).toBe(true);
  });

  it('releases the legacy Set lease after a failed protocol lookup', async () => {
    const peers = new Set<string>();
    const f = fixture(kind, peers);
    const failure = new Error('lookup failed');
    f.context.getPeerProtocols.mockRejectedValueOnce(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(peers.size).toBe(0);
  });

  it('honors an already-aborted explicit lifetime before acquiring a legacy peer', async () => {
    const peers = new Set<string>();
    const f = fixture(kind, peers);
    const controller = new AbortController();
    const failure = new Error('owner closed');
    controller.abort(failure);
    await expect(f.run(controller.signal)).rejects.toBe(failure);
    expect(peers.size).toBe(0);
    expect(f.context.getPeerProtocols).not.toHaveBeenCalled();
  });

  it('fences a legacy continuation after the supplied lifetime closes', async () => {
    const peers = new Set<string>();
    const f = fixture(kind, peers);
    const entered = deferred<void>();
    const gate = deferred<string[]>();
    f.context.getPeerProtocols.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
    const controller = new AbortController();
    const attempt = f.run(controller.signal);
    const settled = attempt.catch(error => error);
    try {
      await Promise.race([entered.promise, attempt]);
      expect(peers.has('legacy-peer')).toBe(true);
      const failure = new Error('owner closed during identify');
      controller.abort(failure);
      gate.resolve([PROTOCOL_SYNC]);
      expect(await settled).toBe(failure);
      expect(f.transfer).not.toHaveBeenCalled();
      expect(f.context.onSyncAccounting).not.toHaveBeenCalled();
      expect(peers.size).toBe(0);
    } finally {
      gate.resolve([PROTOCOL_SYNC]);
      await settled;
    }
  });

  it('uses the supplied modern lease owner unchanged', async () => {
    const release = vi.fn();
    const owner = { tryAcquirePeer: vi.fn(() => release) };
    expect(await fixture(kind, owner).run(new AbortController().signal)).toBe('synced');
    expect(owner.tryAcquirePeer).toHaveBeenCalledExactlyOnceWith('legacy-peer');
    expect(release).toHaveBeenCalledOnce();
  });
});

it('coordinates ordinary and selected legacy calls through the same Set', async () => {
  const peers = new Set<string>();
  const ordinary = fixture('ordinary', peers);
  const selected = fixture('selected', peers);
  const entered = deferred<void>();
  const gate = deferred<string[]>();
  ordinary.context.getPeerProtocols.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
  const first = ordinary.run();
  try {
    await Promise.race([entered.promise, first]);
    expect(await selected.run()).toBe('already-syncing');
    expect(selected.transfer).not.toHaveBeenCalled();
    gate.resolve([PROTOCOL_SYNC]);
    expect(await first).toBe('synced');
    expect(await selected.run()).toBe('synced');
    expect(peers.size).toBe(0);
  } finally {
    gate.resolve([PROTOCOL_SYNC]);
    await first.catch(() => {});
  }
});
