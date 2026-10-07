import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_STALE_MAX_MS,
  VmHolderTierController,
  type HolderProfilePageRequest,
  type VmHolderGraphPolicy,
} from '../src/vm-reconcile-holder-tier.js';

const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';
const SELF = '12D3KooWSelf';
const HOLDER_A = '12D3KooWHolderAAAAAAAA';
const HOLDER_B = '12D3KooWHolderBBBBBBBB';

afterEach(() => { vi.useRealTimers(); });

/**
 * A controller over fake chain, phonebook, policy and clock. `reads.table` counts
 * the shared resolutions (one ShardingTable read each), which is how these tests
 * see whether the hints cache was kept or forgotten.
 */
function build(options: { policy?: (cg: string) => VmHolderGraphPolicy | Promise<VmHolderGraphPolicy> } = {}) {
  const state = {
    clock: 1_000_000,
    enabled: true,
    rows: [{ peerId: HOLDER_A, agentAddress: WALLET_A }] as Array<{ peerId: string; agentAddress: string }>,
    identities: new Map<string, bigint>([[WALLET_A, 7n], [WALLET_B, 8n]]),
    table: [7n, 8n] as bigint[],
    policyReads: [] as string[],
    logs: [] as string[],
    reads: { table: 0 },
  };
  const controller = new VmHolderTierController({
    enabled: () => state.enabled,
    readPolicy: async (cg) => {
      state.policyReads.push(cg);
      return options.policy ? options.policy(cg) : 'public';
    },
    hints: {
      listShardingTableIdentityIds: async () => {
        state.reads.table += 1;
        return state.table;
      },
      getIdentityIdForAddress: async (address) => state.identities.get(address.toLowerCase()) ?? 0n,
      listCoreProfileHints: async (request: HolderProfilePageRequest) => ({
        hints: state.rows.slice(0, request.limit),
        next: null,
      }),
      selfPeerId: () => SELF,
      now: () => state.clock,
    },
    log: (message) => state.logs.push(message),
  });
  const refresh = (cg: string, extra: { signal?: AbortSignal; isCurrent?: () => boolean } = {}) => controller.refresh(cg, {
    signal: extra.signal,
    isCurrent: extra.isCurrent ?? (() => true),
  });
  return { state, controller, refresh };
}

describe('VmHolderTierController.refresh', () => {
  it('resolves a public graph, remembers its set and logs the change once', async () => {
    const { state, controller, refresh } = build();
    await refresh('cg-a');
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
    expect(controller.entryFor('cg-a')).toEqual({
      peerIds: [HOLDER_A],
      resolvedAt: state.clock,
      nextCheckAt: state.clock + VM_HOLDER_TIER_RESOLUTION_TTL_MS,
    });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toContain('VM exact fetch holder tier for "cg-a": 1 hinted ShardingTable holder(s)');
    expect(state.logs[0]).toContain(`[peers=${HOLDER_A.slice(-8)}]`);
    expect(state.logs[0]).toContain('routing hints only, data is still verified against on-chain roots');

    // Due again after its cadence: re-read, the same set, so nothing is logged again.
    state.clock += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    await refresh('cg-a');
    expect(state.logs).toHaveLength(1);
    // A changed set is logged.
    state.rows.push({ peerId: HOLDER_B, agentAddress: WALLET_B });
    state.clock += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    await refresh('cg-a');
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A, HOLDER_B]);
    expect(state.logs).toHaveLength(2);
  });

  it('reads nothing while an entry is not due, and shares one resolution across graphs', async () => {
    const { state, controller, refresh } = build();
    await refresh('cg-a');
    await refresh('cg-a');
    expect(state.policyReads).toEqual(['cg-a']);
    // A second graph reads its own policy but reuses the shared resolution.
    await refresh('cg-b');
    expect(state.policyReads).toEqual(['cg-a', 'cg-b']);
    expect(state.reads.table).toBe(1);
    expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
  });

  it('gives a private graph an empty tier without reading the chain, and an unknown policy the failure spacing', async () => {
    const policies: Record<string, VmHolderGraphPolicy> = { priv: 'not-public', unk: 'unknown' };
    const { state, controller, refresh } = build({ policy: (cg) => policies[cg] ?? 'public' });
    await refresh('priv');
    await refresh('unk');
    expect(state.reads.table).toBe(0);
    expect(controller.entryFor('priv')).toEqual({
      peerIds: [],
      resolvedAt: state.clock,
      nextCheckAt: state.clock + VM_HOLDER_TIER_RESOLUTION_TTL_MS,
    });
    expect(controller.entryFor('unk')).toEqual({
      peerIds: [],
      resolvedAt: state.clock,
      nextCheckAt: state.clock + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
  });

  it('forgets the graph and reads nothing while the tier is switched off', async () => {
    const { state, controller, refresh } = build();
    await refresh('cg-a');
    state.enabled = false;
    await refresh('cg-a');
    expect(controller.entryFor('cg-a')).toBeUndefined();
    expect(controller.peerIdsFor('cg-a')).toEqual([]);
    await refresh('cg-b');
    expect(controller.entryFor('cg-b')).toBeUndefined();
    expect(state.policyReads).toEqual(['cg-a']);
    // Switched back on, the next refresh resolves again.
    state.enabled = true;
    await refresh('cg-a');
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
  });

  describe('failures stay inside the state model', () => {
    it('moves a resolved entry through the unavailable transition when the policy read rejects', async () => {
      let failing = false;
      const { state, controller, refresh } = build({
        policy: () => {
          if (failing) throw new Error('policy store down');
          return 'public';
        },
      });
      await refresh('cg-a');
      const resolved = controller.entryFor('cg-a')!;
      failing = true;
      state.clock += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
      await refresh('cg-a');
      expect(controller.entryFor('cg-a')).toEqual({
        peerIds: [HOLDER_A],
        resolvedAt: resolved.resolvedAt,
        nextCheckAt: state.clock + VM_HOLDER_TIER_FAILURE_RETRY_MS,
      });
      state.clock = resolved.resolvedAt + VM_HOLDER_TIER_STALE_MAX_MS;
      await refresh('cg-a');
      expect(controller.entryFor('cg-a')).toEqual({
        peerIds: [],
        resolvedAt: state.clock,
        nextCheckAt: state.clock + VM_HOLDER_TIER_FAILURE_RETRY_MS,
      });
    });

    it('treats a policy answer it does not know as unknown', async () => {
      const { controller, refresh } = build({ policy: () => 'maybe' as unknown as VmHolderGraphPolicy });
      await refresh('cg-a');
      expect(controller.entryFor('cg-a')?.peerIds).toEqual([]);
    });

    it('bounds a policy read that ignores its abort signal', async () => {
      const { state, controller, refresh } = build({ policy: () => new Promise<VmHolderGraphPolicy>(() => undefined) });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let done = false;
      const running = refresh('cg-a').then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_POLICY_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      await running;
      expect(controller.entryFor('cg-a')).toEqual({
        peerIds: [],
        resolvedAt: state.clock,
        nextCheckAt: state.clock + VM_HOLDER_TIER_FAILURE_RETRY_MS,
      });
    });

    it('writes nothing when the caller aborts during the policy read or the shared read', async () => {
      const duringPolicy = new AbortController();
      const first = build({
        policy: async () => {
          duringPolicy.abort(new Error('caller gone'));
          throw new Error('aborted mid-read');
        },
      });
      await expect(first.refresh('cg-a', { signal: duringPolicy.signal })).resolves.toBeUndefined();
      expect(first.controller.entryFor('cg-a')).toBeUndefined();

      const duringResolve = new AbortController();
      const second = build();
      const pending = second.refresh('cg-a', { signal: duringResolve.signal });
      duringResolve.abort(new Error('caller gone'));
      await expect(pending).resolves.toBeUndefined();
      expect(second.controller.entryFor('cg-a')).toBeUndefined();
    });

    it('writes nothing for a lifecycle that ended while a read was pending', async () => {
      const afterPolicy = build();
      await afterPolicy.refresh('cg-a', { isCurrent: () => false });
      expect(afterPolicy.controller.entryFor('cg-a')).toBeUndefined();
      expect(afterPolicy.state.reads.table).toBe(0);

      let current = true;
      const afterResolve = build({ policy: () => { current = false; return 'public'; } });
      await afterResolve.refresh('cg-a', { isCurrent: () => current });
      expect(afterResolve.controller.entryFor('cg-a')).toBeUndefined();
    });

    it('rejects for a defect and records no transition for it', async () => {
      const { state, controller } = build();
      const defect = new TypeError('selfPeerId is not a function');
      const broken = new VmHolderTierController({
        enabled: () => true,
        readPolicy: async () => 'public',
        hints: {
          listShardingTableIdentityIds: async () => [7n],
          getIdentityIdForAddress: async () => 7n,
          listCoreProfileHints: async () => ({ hints: [{ peerId: HOLDER_A, agentAddress: WALLET_A }], next: null }),
          selfPeerId: () => { throw defect; },
          now: () => state.clock,
        },
        log: () => undefined,
      });
      await expect(broken.refresh('cg-a', { isCurrent: () => true })).rejects.toBe(defect);
      expect(broken.entryFor('cg-a')).toBeUndefined();
      expect(controller.entryFor('cg-a')).toBeUndefined();
    });

    it('drops the answer of a read that was in flight when the hints were invalidated', async () => {
      const { state } = build();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      // Hold the first shared read after it has seen the phonebook.
      const holdingController = new VmHolderTierController({
        enabled: () => true,
        readPolicy: async () => 'public',
        hints: {
          listShardingTableIdentityIds: async () => [7n, 8n],
          getIdentityIdForAddress: async (address) => state.identities.get(address.toLowerCase()) ?? 0n,
          listCoreProfileHints: async () => {
            const snapshot = state.rows.slice();
            if (first) {
              first = false;
              await gate;
            }
            return { hints: snapshot, next: null };
          },
          selfPeerId: () => SELF,
          now: () => state.clock,
        },
        log: () => undefined,
      });
      const inFlight = holdingController.refresh('cg-a', { isCurrent: () => true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Holder B's profile arrives: the tier forgets its hints and this graph's set, and a recovery is asked for.
      state.rows.push({ peerId: HOLDER_B, agentAddress: WALLET_B });
      holdingController.invalidateHints(['cg-a']);
      release();
      await inFlight;
      expect(holdingController.entryFor('cg-a')).toBeUndefined();
      await holdingController.refresh('cg-a', { isCurrent: () => true });
      expect(holdingController.peerIdsFor('cg-a')).toEqual([HOLDER_A, HOLDER_B]);
    });
  });
});

describe('VmHolderTierController lifecycle: every operation keeps the two caches in step', () => {
  /** Two graphs resolved, one shared resolution behind them. */
  async function twoGraphs() {
    const fixture = build();
    await fixture.refresh('cg-a');
    await fixture.refresh('cg-b');
    expect(fixture.state.reads.table).toBe(1);
    return fixture;
  }

  it('refresh: writes its own graph and fills the shared hints once', async () => {
    const { state, controller } = await twoGraphs();
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
    expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
    // Both caches are populated: a third graph needs no new shared read.
    await controller.refresh('cg-c', { isCurrent: () => true });
    expect(state.reads.table).toBe(1);
  });

  it('invalidateHints: forgets the shared hints and the listed graphs\' sets, and no other graph\'s', async () => {
    const { state, controller, refresh } = await twoGraphs();
    controller.invalidateHints(['cg-a']);
    expect(controller.entryFor('cg-a')).toBeUndefined();
    expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
    // The shared hints went too: the next graph to refresh reads the chain again.
    await refresh('cg-a');
    expect(state.reads.table).toBe(2);
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
  });

  it('invalidateHints: forgets the shared hints even when no graph is listed', async () => {
    const { state, controller, refresh } = await twoGraphs();
    controller.invalidateHints([]);
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
    expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
    await refresh('cg-c');
    expect(state.reads.table).toBe(2);
  });

  it('deleteGraph: drops that graph\'s set only and keeps the graph-independent hints', async () => {
    const { state, controller, refresh } = await twoGraphs();
    controller.deleteGraph('cg-a');
    expect(controller.entryFor('cg-a')).toBeUndefined();
    expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
    // The hints were kept: a graph refreshed now reuses them.
    await refresh('cg-a');
    await refresh('cg-c');
    expect(state.reads.table).toBe(1);
    // Deleting a graph that has no set is a no-op.
    expect(() => controller.deleteGraph('never-seen')).not.toThrow();
  });

  it('prune: keeps the most recently refreshed graphs and the shared hints', async () => {
    const { state, controller, refresh } = build();
    for (const cg of ['cg-1', 'cg-2', 'cg-3', 'cg-4']) await refresh(cg);
    // cg-1 is refreshed again, so it is the newest.
    state.clock += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    await refresh('cg-1');
    controller.prune(2);
    expect(['cg-1', 'cg-2', 'cg-3', 'cg-4'].map((cg) => controller.entryFor(cg) !== undefined))
      .toEqual([true, false, false, true]);
    // The hints were kept.
    const reads = state.reads.table;
    await refresh('cg-9');
    expect(state.reads.table).toBe(reads);
    // Nothing to drop within the bound.
    controller.prune(100);
    expect(controller.entryFor('cg-1')).toBeDefined();
  });

  it('close: forgets every graph\'s set and the shared hints together, and stays usable', async () => {
    const { state, controller, refresh } = await twoGraphs();
    controller.close();
    expect(controller.peerIdsFor('cg-a')).toEqual([]);
    expect(controller.peerIdsFor('cg-b')).toEqual([]);
    await refresh('cg-a');
    expect(state.reads.table).toBe(2);
    expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
  });

  describe('a phonebook larger than one resolution\'s window', () => {
    const FLOOD = 1_100;
    const LATE_WALLET = `0x${(0xf0000000).toString(16).padStart(40, '0')}`;
    /** A phonebook of junk that sorts ahead of the one genuine holder, paged like the real one. */
    function floodedController() {
      const rows = [
        ...Array.from({ length: FLOOD }, (_, i) => ({
          peerId: `peer-flood-${String(i).padStart(5, '0')}`,
          agentAddress: `0x${(0x1000 + Math.floor(i / 28)).toString(16).padStart(40, '0')}`,
        })),
        { peerId: HOLDER_A, agentAddress: LATE_WALLET },
      ];
      const requests: Array<string | undefined> = [];
      const state = { clock: 1_000_000, tableReads: 0 };
      const controller = new VmHolderTierController({
        enabled: () => true,
        readPolicy: async () => 'public',
        hints: {
          listShardingTableIdentityIds: async () => { state.tableReads += 1; return [7n]; },
          getIdentityIdForAddress: async (address) => (address.toLowerCase() === LATE_WALLET ? 7n : 0n),
          listCoreProfileHints: async (request: HolderProfilePageRequest) => {
            requests.push(request.after?.peerId);
            const { after } = request;
            const offset = after === undefined
              ? 0
              : rows.findIndex((row) => row.agentAddress === after.agentAddress && row.peerId === after.peerId) + 1;
            const hints = rows.slice(offset, offset + request.limit);
            const last = hints[hints.length - 1];
            return { hints, next: offset + hints.length < rows.length && last ? { agentAddress: last.agentAddress, peerId: last.peerId } : null };
          },
          selfPeerId: () => SELF,
          now: () => state.clock,
        },
        log: () => undefined,
      });
      return { controller, requests, state };
    }

    it('walks on window by window through refreshes, and a phonebook arrival keeps its place', async () => {
      const { controller, requests, state } = floodedController();
      const refresh = () => controller.refresh('cg-a', { isCurrent: () => true });
      await refresh();
      // The first window is all junk: no holder yet, and the graph is due again soon.
      expect(controller.peerIdsFor('cg-a')).toEqual([]);
      expect(controller.entryFor('cg-a')?.nextCheckAt).toBe(state.clock + VM_HOLDER_TIER_FAILURE_RETRY_MS);
      const firstWindow = requests.length;
      // A phonebook arrival forgets the cached answer and the graph's set, not the walk.
      controller.invalidateHints(['cg-a']);
      await refresh();
      expect(requests[firstWindow]).toBeDefined();
      expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
    });

    it('close starts the walk over from the first row and forgets what it carried', async () => {
      const { controller, requests, state } = floodedController();
      const refresh = () => controller.refresh('cg-a', { isCurrent: () => true });
      await refresh();
      state.clock += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      await refresh();
      expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
      const before = requests.length;
      controller.close();
      expect(controller.peerIdsFor('cg-a')).toEqual([]);
      await refresh();
      // Nothing carried, nothing remembered of where the walk was: it reads from the first row again.
      expect(requests[before]).toBeUndefined();
      expect(controller.peerIdsFor('cg-a')).toEqual([]);
    });

    it('deleteGraph and prune leave the walk and its carried bindings alone', async () => {
      const { controller, requests, state } = floodedController();
      const refresh = (cg: string) => controller.refresh(cg, { isCurrent: () => true });
      await refresh('cg-a');
      state.clock += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      await refresh('cg-a');
      expect(controller.peerIdsFor('cg-a')).toEqual([HOLDER_A]);
      controller.deleteGraph('cg-a');
      controller.prune(0);
      const before = requests.length;
      // Another graph reuses the resolution the walk produced: the holder is already carried.
      await refresh('cg-b');
      expect(controller.peerIdsFor('cg-b')).toEqual([HOLDER_A]);
      expect(requests.length).toBe(before);
    });
  });

  it('lifecycle operations before any refresh are no-ops that start no resolution', () => {
    const { state, controller } = build();
    controller.invalidateHints(['cg-a']);
    controller.deleteGraph('cg-a');
    controller.prune(0);
    controller.close();
    expect(controller.peerIdsFor('cg-a')).toEqual([]);
    expect(controller.entryFor('cg-a')).toBeUndefined();
    expect(state.reads.table).toBe(0);
    expect(state.policyReads).toEqual([]);
  });
});
