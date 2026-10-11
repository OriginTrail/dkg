import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type {
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSubscriptionRecord,
} from '../src/dkg-agent-types.js';
import type { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import type { OnChainContextGraphFacts } from '../src/context-graph-storage-discovery.js';
import type { CursorState } from '../src/reconcile-cursor.js';

const LOCAL_ID = 'duplicate-name-binding';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL_ID)).toLowerCase();
const OWNED_ID = '582';
const FOREIGN_ID = '323';
const OWNED_OWNER = `0x${'11'.repeat(20)}`;
const FOREIGN_OWNER = `0x${'22'.repeat(20)}`;
const TRANSFERRED_OWNER = `0x${'33'.repeat(20)}`;
const sources = ['event', 'storage', 'checkpoint'] as const;
type ObservationSource = typeof sources[number];

interface BindingInternals {
  setContextGraphSubscription(
    id: string,
    next: ContextGraphSubInput,
    options?: { persist?: boolean },
  ): ContextGraphSub;
  bindSubscriptionOnChainId(id: string, sub: ContextGraphSub, newId: string): void;
  persistContextGraphSubscription(id: string): Promise<void>;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  scheduleRfc64CatalogResponsibilityReconciliationV1(id: string): boolean;
  reconcileSwmHostModeSubscription(...args: unknown[]): Promise<void>;
  recordCoreHostedPublicCg(id: string, localId: string, options?: { nudge?: boolean }): Promise<string>;
  contextGraphBindingState: ContextGraphBindingState;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  reconcileCursors: Map<string, CursorState>;
  onChainContextGraphFacts: { get(id: string): OnChainContextGraphFacts | undefined };
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  while (agents.length > 0) await agents.pop()!.stop();
  vi.restoreAllMocks();
});

async function fixture(hostOnly = false) {
  const chain = new MockChainAdapter('mock:31337', undefined, {
    initialContextGraphId: BigInt(OWNED_ID),
  });
  await chain.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
    nameHash: NAME_HASH,
  });
  const saved = new Map<string, ContextGraphSubscriptionRecord>();
  const save = vi.fn(async (record: ContextGraphSubscriptionRecord) => {
    saved.set(record.id, { ...record });
  });
  const remove = vi.fn(async (id: string) => { saved.delete(id); });
  // create() composes the native methods; this agent is never started.
  const agent = await DKGAgent.create({
    name: 'DuplicateNameBinding',
    chainAdapter: chain,
    nodeRole: hostOnly ? 'core' : 'edge',
    vmReconcilerEnabled: true,
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionStore: {
      loadAll: async () => [...saved.values()],
      save,
      delete: remove,
    },
  });
  agents.push(agent);
  const internals = agent as unknown as BindingInternals;
  // Like core-fills-gap's unstarted fixture, supply the owned peer identity
  // needed by native membership persistence without starting libp2p.
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWDuplicateNameBindingTestPeer',
    libp2p: { getPeers: () => [] },
  };
  // Isolate the binding from detached catalog work and network host admission.
  // The observation, binder, subscription setter, facts and persistence stay real.
  vi.spyOn(internals, 'scheduleRfc64CatalogResponsibilityReconciliationV1')
    .mockReturnValue(false);
  const hostNudge = vi.spyOn(internals, 'reconcileSwmHostModeSubscription')
    .mockResolvedValue(undefined);
  const subscription = internals.setContextGraphSubscription(LOCAL_ID, {
    subscribed: !hostOnly,
    coreHosted: hostOnly,
    syncMode: 'always-on',
    synced: true,
    metaSynced: true,
    onChainId: OWNED_ID,
    onChainHash: NAME_HASH,
    lastReconciledOrdinal: 7,
  }, { persist: false });
  const cursor: CursorState = {
    watermark: 7,
    ahead: new Map([[9, 150]]),
    scanOrdinal: 10,
  };
  internals.reconcileCursors.set(LOCAL_ID, cursor);
  const persist = vi.spyOn(internals, 'persistContextGraphSubscription');
  const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
  const query = vi.spyOn(agent.store, 'query');
  const drainPersistence = () => internals.enqueueContextGraphSubscriptionPersistWrite(
    LOCAL_ID, async () => undefined,
  );
  return {
    agent, chain, internals, subscription, cursor, save, remove, persist,
    hostNudge, reverse, query, drainPersistence,
  };
}

function observation(id: string, owner: string, block: number) {
  return {
    contextGraphId: id,
    nameHash: NAME_HASH,
    owner,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: owner,
    active: true,
    createdAt: 1_790_000_000,
    observedAtBlock: block,
  };
}

const conflictCases = sources.flatMap((source) => [
  { source, order: 'owned then foreign', ids: [OWNED_ID, FOREIGN_ID] },
  { source, order: 'foreign then owned', ids: [FOREIGN_ID, OWNED_ID] },
]);

describe('duplicate Context Graph name hash observations', () => {
  it.each(conflictCases)(
    'preserves exact authority through $source observations: $order',
    async ({ source, ids }) => {
      const f = await fixture();
      const generation = f.internals.contextGraphBindingState.capture(LOCAL_ID);
      for (const id of [...ids, FOREIGN_ID]) {
        f.persist.mockClear();
        f.save.mockClear();
        f.remove.mockClear();
        f.hostNudge.mockClear();
        f.agent.applyOnChainContextGraphObservation(
          // A newer observation of another slot still cannot own this namespace.
          observation(id, id === OWNED_ID ? OWNED_OWNER : FOREIGN_OWNER,
            id === OWNED_ID ? 100 : 200),
          { source },
        );
        await f.drainPersistence();

        // On the unfixed source this fails with received323, not a harness error.
        await expect(f.agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe(OWNED_ID);
        expect(f.internals.wireIdToLocalCgId.get(NAME_HASH)).toBe(LOCAL_ID);
        expect(f.internals.subscribedContextGraphs.get(LOCAL_ID)).toMatchObject({
          onChainId: OWNED_ID, onChainHash: NAME_HASH, lastReconciledOrdinal: 7,
        });
        expect(f.internals.reconcileCursors.get(LOCAL_ID)).toBe(f.cursor);
        expect(f.cursor).toEqual({
          watermark: 7, ahead: new Map([[9, 150]]), scanOrdinal: 10,
        });
        expect(f.internals.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation);
        if (id === FOREIGN_ID) {
          expect(f.persist).not.toHaveBeenCalled();
          expect(f.save).not.toHaveBeenCalled();
          expect(f.remove).not.toHaveBeenCalled();
          expect(f.hostNudge).not.toHaveBeenCalled();
          expect(f.internals.onChainContextGraphFacts.get(FOREIGN_ID)).toMatchObject({
            onChainId: FOREIGN_ID, nameHash: NAME_HASH,
            owner: FOREIGN_OWNER, observedAtBlock: 200,
          });
        }
      }
      expect(f.reverse).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it.each(sources)(
    'accepts a same-slot owner transfer from %s without losing reconcile progress',
    async (source: ObservationSource) => {
      const f = await fixture();
      const generation = f.internals.contextGraphBindingState.capture(LOCAL_ID);
      f.agent.applyOnChainContextGraphObservation(
        observation(OWNED_ID, OWNED_OWNER, 100), { source },
      );
      f.agent.applyOnChainContextGraphObservation(
        observation(OWNED_ID, TRANSFERRED_OWNER, 101), { source },
      );
      await f.drainPersistence();

      await expect(f.agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe(OWNED_ID);
      expect(f.internals.onChainContextGraphFacts.get(OWNED_ID)).toMatchObject({
        onChainId: OWNED_ID, owner: TRANSFERRED_OWNER, observedAtBlock: 101,
      });
      expect(f.internals.subscribedContextGraphs.get(LOCAL_ID)?.lastReconciledOrdinal).toBe(7);
      expect(f.internals.reconcileCursors.get(LOCAL_ID)).toBe(f.cursor);
      expect(f.internals.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation);
      expect(f.reverse).not.toHaveBeenCalled();
    },
  );

  it('does not let a conflicting checkpoint replace a host-only exact binding', async () => {
    const f = await fixture(true);
    const generation = f.internals.contextGraphBindingState.capture(LOCAL_ID);
    f.agent.applyOnChainContextGraphObservation(
      observation(FOREIGN_ID, FOREIGN_OWNER, 200), { source: 'checkpoint' },
    );
    await f.drainPersistence();

    await expect(f.agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe(OWNED_ID);
    expect(f.internals.subscribedContextGraphs.get(LOCAL_ID)).toBe(f.subscription);
    expect(f.subscription).toMatchObject({
      subscribed: false, coreHosted: true, onChainId: OWNED_ID,
      lastReconciledOrdinal: 7,
    });
    expect(f.internals.reconcileCursors.get(LOCAL_ID)).toBe(f.cursor);
    expect(f.internals.contextGraphBindingState.capture(LOCAL_ID)).toBe(generation);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.hostNudge).not.toHaveBeenCalled();
    expect(f.internals.onChainContextGraphFacts.get(FOREIGN_ID)?.owner).toBe(FOREIGN_OWNER);
  });

  it('allows the native verified retired-host rebind and resets old progress', async () => {
    const f = await fixture(true);
    const generation = f.internals.contextGraphBindingState.capture(LOCAL_ID);
    // This separate owner permits a new binding only after checking old liveness.
    f.chain.getContextGraph(BigInt(OWNED_ID))!.active = false;
    const replacement = await f.chain.createOnChainContextGraph({
      accessPolicy: 0, publishPolicy: 1, nameHash: NAME_HASH,
    });
    const replacementId = replacement.contextGraphId.toString();
    // The mock point-read checks only map membership; model the fixture's
    // retired flag explicitly, as core-fills-gap's verified-rebind control does.
    const active = vi.spyOn(f.chain, 'isContextGraphActiveOnChain')
      .mockImplementation(async (id) => f.chain.getContextGraph(id)?.active === true);

    await expect(f.internals.recordCoreHostedPublicCg(replacementId, LOCAL_ID, { nudge: false }))
      .resolves.toBe('recorded');
    await f.drainPersistence();

    expect(active).toHaveBeenCalledWith(BigInt(OWNED_ID));
    expect(f.internals.subscribedContextGraphs.get(LOCAL_ID)).toMatchObject({
      subscribed: false, coreHosted: true, onChainId: replacementId,
      lastReconciledOrdinal: 0,
    });
    expect(f.internals.reconcileCursors.has(LOCAL_ID)).toBe(false);
    expect(f.internals.contextGraphBindingState.capture(LOCAL_ID)).toBeGreaterThan(generation);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({
      id: LOCAL_ID, onChainId: replacementId, lastReconciledOrdinal: 0,
    }));
  });
});
