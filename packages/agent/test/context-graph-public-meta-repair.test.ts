import { describe, expect, it, vi } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaAskQuery } from '../src/context-graph-public-meta-proof.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  repairChainAttestedPublicMetaProjection,
  repairCreatorPublicMetaProjections,
} from '../src/context-graph-public-meta-repair.js';

const CREATOR_PEER = '12D3KooWCreatorPublicMetaRepair111111111111111111111111';
const FOREIGN_PEER = '12D3KooWForeignPublicMetaRepair111111111111111111111111';

function publicOntologyDefinition(contextGraphId: string, creatorPeerId: string): Quad[] {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const graph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  return [
    {
      subject,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${creatorPeerId}`,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"public"',
      graph,
    },
  ];
}

async function hasPublicProof(store: OxigraphStore, contextGraphId: string): Promise<boolean> {
  const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
  expect(result.type).toBe('boolean');
  return result.type === 'boolean' && result.value;
}

describe('creator-owned public metadata projection repair', () => {
  it('backfills the complete root proof for a creator-owned legacy public graph', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-missing-meta-proof';
    try {
      await store.insert(publicOntologyDefinition(contextGraphId, CREATOR_PEER));

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired).toEqual({
        candidates: 1,
        repairedGraphs: 1,
        insertedTriples: 2,
        conflictingGraphs: [],
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('repairs only the missing fact and is idempotent', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-partial-meta-proof';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '" PuBlIc "',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const first = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);
      const second = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(first.repairedGraphs).toBe(1);
      expect(first.insertedTriples).toBe(1);
      expect(second.repairedGraphs).toBe(0);
      expect(second.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('does not make a foreign network-discovered graph authoritative locally', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'foreign-public-missing-meta-proof';
    try {
      await store.insert(publicOntologyDefinition(contextGraphId, FOREIGN_PEER));

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.candidates).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('fails closed when creator-owned root metadata has a conflicting policy', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-conflicting-meta-policy';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.repairedGraphs).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(repaired.conflictingGraphs).toEqual([contextGraphId]);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('fails closed when the ontology has conflicting creator or policy claims', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-conflicting-ontology';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: `did:dkg:agent:${FOREIGN_PEER}`,
          graph: ontologyGraph,
        },
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: ontologyGraph,
        },
      ]);

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.candidates).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe('chain-attested public metadata projection repair', () => {
  it('uses one active-public proof for placeholder repair and confirmation', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/single-proof';
    const resolveOnChainAccessPolicyState = vi.fn(async () => 0 as const);
    const isContextGraphPublicOnChain = vi.fn(async () => {
      throw new Error('confirmation must reuse the repair proof');
    });
    const agentLike: any = {
      store,
      chain: {},
      peerId: CREATOR_PEER,
      resolveOnChainAccessPolicyState,
      isContextGraphPublicOnChain,
      isPrivateContextGraph: vi.fn(async () => false),
      isCuratorOf: vi.fn(async () => false),
      hasConfirmedMetaState: LifecycleSyncMethods.prototype.hasConfirmedMetaState,
      localApprovedAgentByCG: new Map(),
      subscribedContextGraphs: new Map(),
    };
    try {
      await store.insert([{
        subject: contextGraphDataGraphUri(contextGraphId),
        predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
        object: '"unregistered"',
        graph: contextGraphMetaGraphUri(contextGraphId),
      }]);

      const reconciliation = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike, contextGraphId);

      expect(reconciliation).toEqual({
        outcome: 'authoritative',
        repair: {
          outcome: 'projection-complete',
          chainProof: { state: 'public' },
        },
      });
      expect(resolveOnChainAccessPolicyState).toHaveBeenCalledTimes(1);
      expect(isContextGraphPublicOnChain).not.toHaveBeenCalled();
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('reuses negative and positive chain evidence through the real confirmation path', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/lifecycle-wiring';
    const resolveOnChainAccessPolicyState = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const agentLike = {
      store,
      chain: {},
      peerId: CREATOR_PEER,
      resolveOnChainAccessPolicyState,
      isContextGraphPublicOnChain: vi.fn(async () => true),
      isPrivateContextGraph: vi.fn(async () => false),
      isCuratorOf: vi.fn(async () => false),
      localApprovedAgentByCG: new Map(),
      subscribedContextGraphs: new Map(),
    };
    try {
      const first = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike as never, contextGraphId);
      expect(first).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        repair: {
          outcome: 'not-chain-attested',
          chainProof: { state: 'not-public', reason: 'private' },
        },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
      expect(agentLike.isContextGraphPublicOnChain).not.toHaveBeenCalled();

      const second = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike as never, contextGraphId);
      expect(second).toEqual({
        outcome: 'authoritative',
        repair: {
          outcome: 'projection-complete',
          chainProof: { state: 'public' },
        },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
      expect(resolveOnChainAccessPolicyState.mock.calls.map(([id]) => id)).toEqual([
        contextGraphId,
        contextGraphId,
      ]);
      expect(agentLike.isContextGraphPublicOnChain).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('preserves an RPC rejection as an unknown chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/rpc-failure';
    const resolveOnChainAccessPolicyState = vi.fn(async () => {
      throw new Error('temporary RPC outage');
    });
    try {
      const reconciliation = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(
          {
            store,
            chain: {},
            peerId: CREATOR_PEER,
            resolveOnChainAccessPolicyState,
            isContextGraphPublicOnChain: vi.fn(async () => false),
            isPrivateContextGraph: vi.fn(async () => false),
            isCuratorOf: vi.fn(async () => false),
            localApprovedAgentByCG: new Map(),
            subscribedContextGraphs: new Map(),
          } as never,
          contextGraphId,
        );

      expect(reconciliation).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        repair: {
          outcome: 'not-chain-attested',
          chainProof: {
            state: 'unknown',
            reason: 'rpc-failure',
            detail: 'temporary RPC outage',
          },
        },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('classifies name-hash transport failures as rpc-failure without a second chain read', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/hash-rpc-failure';
    const getContextGraphNameHash = vi.fn(async () => {
      throw Object.assign(new Error('RPC endpoints exhausted'), {
        code: 'RPC_ENDPOINTS_EXHAUSTED',
      });
    });
    const isContextGraphPublicOnChain = vi.fn(
      DKGAgent.prototype.isContextGraphPublicOnChain,
    );
    const agentLike: any = {
      store,
      chain: {
        getContextGraphNameHash,
        getContextGraphAccessPolicy: vi.fn(async () => 0 as const),
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId: vi.fn(async () => '42'),
      contextGraphExists: vi.fn(async () => false),
      subscribedContextGraphs: new Map(),
      wireIdToLocalCgId: new Map(),
      onChainAccessPolicyCache: new Map(),
      localApprovedAgentByCG: new Map(),
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      peerId: CREATOR_PEER,
      isCuratorOf: vi.fn(async () => false),
      isPrivateContextGraph: vi.fn(async () => false),
      isContextGraphPublicOnChain,
    };
    agentLike.resolveOnChainAccessPolicyState = DKGAgent.prototype.resolveOnChainAccessPolicyState;
    agentLike.localCgMatchesOnChainSlot = DKGAgent.prototype.localCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = DKGAgent.prototype.isWireIdKeyedSubscription;
    agentLike.readLiveOnChainAccessPolicy = DKGAgent.prototype.readLiveOnChainAccessPolicy;
    agentLike.raceChainPolicyRead = DKGAgent.prototype.raceChainPolicyRead;
    try {
      const reconciliation = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike, contextGraphId);

      expect(reconciliation).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        repair: {
          outcome: 'not-chain-attested',
          chainProof: {
            state: 'unknown',
            reason: 'rpc-failure',
            detail: 'RPC endpoints exhausted',
          },
        },
      });
      expect(getContextGraphNameHash).toHaveBeenCalledWith(42n);
      expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
      expect(isContextGraphPublicOnChain).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('requires name-hash proof for a numeric local mapping but preserves raw-slot addressing', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '42';
    const getContextGraphNameHash = vi.fn(async () => (
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ));
    const getContextGraphAccessPolicy = vi.fn(async () => 0 as const);
    const agentLike: any = {
      store,
      chain: {
        getContextGraphNameHash,
        getContextGraphAccessPolicy,
        isContextGraphActiveOnChain: vi.fn(async () => true),
      },
      getContextGraphOnChainId: vi.fn()
        .mockResolvedValueOnce('42')
        .mockResolvedValueOnce(null),
      contextGraphExists: vi.fn(async () => false),
      subscribedContextGraphs: new Map(),
      wireIdToLocalCgId: new Map(),
      onChainAccessPolicyCache: new Map(),
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      isCuratorOf: vi.fn(async () => false),
      isPrivateContextGraph: vi.fn(async () => false),
      localApprovedAgentByCG: new Map(),
      peerId: CREATOR_PEER,
    };
    agentLike.isContextGraphPublicOnChain = DKGAgent.prototype.isContextGraphPublicOnChain;
    agentLike.resolveOnChainAccessPolicyState = DKGAgent.prototype.resolveOnChainAccessPolicyState;
    agentLike.localCgMatchesOnChainSlot = DKGAgent.prototype.localCgMatchesOnChainSlot;
    agentLike.isWireIdKeyedSubscription = DKGAgent.prototype.isWireIdKeyedSubscription;
    agentLike.readLiveOnChainAccessPolicy = DKGAgent.prototype.readLiveOnChainAccessPolicy;
    agentLike.raceChainPolicyRead = DKGAgent.prototype.raceChainPolicyRead;
    try {
      const reconciliation = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike, contextGraphId);

      expect(reconciliation).toEqual({
        outcome: 'pending',
        reason: 'missing-metadata',
        repair: {
          outcome: 'not-chain-attested',
          chainProof: { state: 'unknown', reason: 'unprovable' },
        },
      });
      expect(getContextGraphNameHash).toHaveBeenCalledWith(42n);
      expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);

      const rawSlotReconciliation = await LifecycleSyncMethods.prototype
        .reconcileConfiguredContextGraphMetadata.call(agentLike, contextGraphId);
      expect(rawSlotReconciliation).toEqual({
        outcome: 'authoritative',
        repair: {
          outcome: 'projection-complete',
          chainProof: { state: 'public' },
        },
      });
      expect(getContextGraphNameHash).toHaveBeenCalledTimes(1);
      expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('backfills creatorless legacy metadata after exact active-public chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/legacy-public';
    try {
      const first = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );
      const second = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );

      expect(first).toEqual({
        outcome: 'projection-complete',
        chainProof: { state: 'public' },
      });
      expect(second).toEqual({
        outcome: 'already-complete',
        chainProof: { state: 'not-requested' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('does not materialize metadata without current-chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'unattested-public-looking-graph';
    try {
      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'not-public', reason: 'unregistered' }),
      );

      expect(repaired).toEqual({
        outcome: 'not-chain-attested',
        chainProof: { state: 'not-public', reason: 'unregistered' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('never overwrites conflicting private root policy', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'chain-public-root-private-conflict';
    try {
      await store.insert([{
        subject: contextGraphDataGraphUri(contextGraphId),
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: contextGraphMetaGraphUri(contextGraphId),
      }]);

      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );

      expect(repaired).toEqual({
        outcome: 'conflicting-policy',
        chainProof: { state: 'public' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('does not insert stale public facts when private policy arrives during chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'chain-public-concurrent-private-conflict';
    try {
      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => {
          await store.insert([{
            subject: contextGraphDataGraphUri(contextGraphId),
            predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
            object: '"private"',
            graph: contextGraphMetaGraphUri(contextGraphId),
          }]);
          return { state: 'public' } as const;
        },
      );

      expect(repaired).toEqual({
        outcome: 'conflicting-policy',
        chainProof: { state: 'public' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
      const typeResult = await store.query(`ASK WHERE {
        GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
          <${contextGraphDataGraphUri(contextGraphId)}> <${DKG_ONTOLOGY.RDF_TYPE}>
            <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }`);
      expect(typeResult).toEqual({ type: 'boolean', value: false });
    } finally {
      await store.close();
    }
  });
});
