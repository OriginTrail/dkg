import {
  MemoryLayer,
  contextGraphLayerUri,
  contextGraphMetaUri,
  type Digest32V1,
  type MemberRosterV1,
} from '@origintrail-official/dkg-core';
import {
  readExactGraphPaged,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
import { createFinalizedVmStoreMaterializerV1 } from '../src/rfc64/finalized-vm-store-materializer-v1.js';
import {
  RFC64_VM_ASSERTION_ROOT,
  RFC64_VM_AUTHOR,
  RFC64_VM_BLOCK_HASH,
  RFC64_VM_CG_STORAGE,
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KAV10,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_NETWORK_ID,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
  RFC64_VM_PUBLISHER,
  createRfc64FinalizedVmPlacementFixture,
  rfc64VmPackKaId,
  rfc64VmUal,
} from './support/rfc64-finalized-vm-placement-fixture.js';
import {
  acceptedRfc64VmPolicySnapshot,
  rfc64FinalizedVmPrecommitOptions as baseOptions,
  rfc64FinalizedVmPrecommitPlan as plan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';
import {
  createFinalizedVmLoopbackRpcV1,
  type FinalizedVmLoopbackFixtureConfigV1,
} from './support/rfc64-finalized-vm-loopback-fixture.js';
import {
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from '../../chain/test/loopback-rpc-harness.js';

const rpcHarness = createLoopbackJsonRpcTestHarness();

afterEach(async () => {
  await rpcHarness.stopAll();
});

function privateFinalizedSnapshot(issuedAt = '1700000000000') {
  const accepted = acceptedRfc64VmPolicySnapshot();
  const policy = Object.freeze({ ...accepted.policy, accessPolicy: 1 as const });
  const roster = Object.freeze({
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest: accepted.policyDigest,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: Object.freeze([Object.freeze({
      agentAddress: RFC64_VM_AUTHOR,
      roles: Object.freeze(['provider'] as const),
    })]),
    issuedAt,
  }) satisfies MemberRosterV1;
  return Object.freeze({ ...accepted, policy, roster });
}

function finalizedChainFixture(
  assertionRoot: Digest32V1 = RFC64_VM_ASSERTION_ROOT,
): FinalizedVmLoopbackFixtureConfigV1 {
  return {
    accessPolicy: 1,
    active: true,
    assertedAtChainId: RFC64_VM_CHAIN_ID,
    assertedAtKav10Address: RFC64_VM_KAV10,
    knowledgeAssetStorageAddress: RFC64_VM_KA_STORAGE,
    assets: [{
      assertionRoot,
      assertionVersion: '2',
      authorAddress: RFC64_VM_AUTHOR,
      kaId: rfc64VmPackKaId(1n),
      publisherAddress: RFC64_VM_PUBLISHER,
    }],
    blockHash: RFC64_VM_BLOCK_HASH,
    blockNumberQuantity: '0x7c',
    contextGraphStorageAddress: RFC64_VM_CG_STORAGE,
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(RFC64_VM_CONTEXT_GRAPH_NAME)) as never,
    networkId: RFC64_VM_NETWORK_ID,
    onChainContextGraphId: RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    ownerAddress: RFC64_VM_AUTHOR,
    publishPolicy: 1,
  };
}

async function liveRpcEndpoint(assertionRoot?: Digest32V1): Promise<string> {
  const rpc = createFinalizedVmLoopbackRpcV1(finalizedChainFixture(assertionRoot));
  const server = await rpcHarness.start((call, response) => {
    try {
      sendJsonRpcResult(response, call, rpc.respond(call.method, call.params));
    } catch (cause) {
      sendJsonRpcError(response, call, -32602, cause instanceof Error ? cause.message : String(cause));
    }
  });
  return server.url;
}


describe('RFC-64 finalized VM agent precommit', () => {
  it('retires a finalized catalog SWM projection only after the applied-head commit', async () => {
    const graphlessProjection: Quad[] = [{
      subject: 'urn:rfc64:post-commit-swm-retirement',
      predicate: 'urn:rfc64:value',
      object: '"finalized"',
      graph: '',
    }];
    const assertionRoot = ethers.hexlify(computeFlatKCRootV10(
      graphlessProjection,
      [],
    )).toLowerCase() as Digest32V1;
    const placement = await createRfc64FinalizedVmPlacementFixture({
      assertionRoot,
      publicTripleCount: graphlessProjection.length,
    });
    const options = baseOptions();
    const { store } = options;
    const swmGraph = contextGraphLayerUri(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      MemoryLayer.SharedWorkingMemory,
      RFC64_VM_AUTHOR,
      1,
    );
    const vmGraph = contextGraphLayerUri(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      MemoryLayer.VerifiableMemory,
      RFC64_VM_AUTHOR,
      1,
    );
    await store.insert(graphlessProjection.map((quad) => ({ ...quad, graph: swmGraph })));
    const retireFinalizedSwm = vi.fn(async (retirement: { swmGraph: string }) => {
      await store.dropGraph(retirement.swmGraph);
    });
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...options,
      acceptedPolicySnapshotForCatalogScope: () => privateFinalizedSnapshot(),
      rpcEndpoints: [await liveRpcEndpoint(assertionRoot)],
      retireFinalizedSwm,
    });

    const transaction = await handler(Object.freeze({
      ...plan(),
      rows: Object.freeze([placement]),
    }), new AbortController().signal);

    await expect(store.hasGraph(swmGraph)).resolves.toBe(true);
    await expect(store.hasGraph(vmGraph)).resolves.toBe(true);
    expect(retireFinalizedSwm).not.toHaveBeenCalled();

    await transaction?.commit();

    await expect(store.hasGraph(swmGraph)).resolves.toBe(false);
    await expect(store.hasGraph(vmGraph)).resolves.toBe(true);
    expect(retireFinalizedSwm).toHaveBeenCalledOnce();
    expect(retireFinalizedSwm).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      kaUal: rfc64VmUal(1n),
      agentAddress: RFC64_VM_AUTHOR,
      kaNumber: 1n,
      swmGraph,
    }));
  });

  it('applies the root-only restriction to private finalized recovery', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const getKnowledgeAssetStorageAddress = vi.fn(async () => RFC64_VM_KA_STORAGE);
    const getKnowledgeAssetsLifecycleAddress = vi.fn(async () => RFC64_VM_KA_STORAGE);
    const materialize = vi.fn();
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      acceptedPolicySnapshotForCatalogScope: () => privateFinalizedSnapshot(),
      getOnChainContextGraphId,
      getEvmChainId,
      getKnowledgeAssetStorageAddress,
      getKnowledgeAssetsLifecycleAddress,
      materialize,
    });
    const namedPlan = {
      ...plan(),
      catalogScope: { ...plan().catalogScope, subGraphName: 'private-lane' },
    } as never;

    await expect(handler(namedPlan, new AbortController().signal)).rejects.toMatchObject({
      name: 'FinalizedVmCompositionErrorV1',
      code: 'finalized-vm-composition-input',
    } satisfies Partial<FinalizedVmCompositionErrorV1>);
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
    expect(getKnowledgeAssetStorageAddress).not.toHaveBeenCalled();
    expect(getKnowledgeAssetsLifecycleAddress).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  it('does not apply the private root-only restriction to a public finalized lane', async () => {
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      rpcEndpoints: [],
    });
    const namedPlan = {
      ...plan(),
      catalogScope: { ...plan().catalogScope, subGraphName: 'public-lane' },
    } as never;

    await expect(handler(namedPlan, new AbortController().signal)).rejects.toThrow(
      'requires trusted RPC configuration',
    );
  });

  it('rejects when the cleartext catalog lane has no numeric on-chain binding', async () => {
    const getOnChainContextGraphId = vi.fn(async () => null);
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'could not resolve the numeric context graph id',
    );
    expect(getOnChainContextGraphId).toHaveBeenCalledWith(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      expect.any(AbortSignal),
    );
  });

  it('rejects before chain resolution when trusted RPC endpoints are empty', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const getKnowledgeAssetStorageAddress = vi.fn(async () => RFC64_VM_KA_STORAGE);
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      rpcEndpoints: [],
      getOnChainContextGraphId,
      getEvmChainId,
      getKnowledgeAssetStorageAddress,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'requires trusted RPC configuration',
    );
    expect(getOnChainContextGraphId).not.toHaveBeenCalled();
    expect(getEvmChainId).not.toHaveBeenCalled();
    expect(getKnowledgeAssetStorageAddress).not.toHaveBeenCalled();
  });

  it('rejects when the live adapter chain differs from the accepted finalized policy', async () => {
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getEvmChainId: async () => 1n,
    });

    await expect(handler(plan(), new AbortController().signal)).rejects.toThrow(
      'policy differs from the configured chain id',
    );
  });

  it('rejects a roster change after private VM materialization and before head commit', async () => {
    const graphlessProjection: Quad[] = [{
      subject: 'urn:rfc64:precommit-roster-change',
      predicate: 'urn:rfc64:value',
      object: '"new"',
      graph: '',
    }];
    const assertionRoot = ethers.hexlify(computeFlatKCRootV10(
      graphlessProjection,
      [],
    )).toLowerCase() as Digest32V1;
    const placement = await createRfc64FinalizedVmPlacementFixture({
      assertionRoot,
      publicTripleCount: graphlessProjection.length,
    });
    const initial = privateFinalizedSnapshot();
    const changed = privateFinalizedSnapshot('1700000000001');
    let rosterChanged = false;
    const acceptedPolicySnapshotForCatalogScope = vi.fn(() => (
      rosterChanged ? changed : initial
    ));
    const options = baseOptions();
    const store = options.store;
    const swmGraph = contextGraphLayerUri(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      MemoryLayer.SharedWorkingMemory,
      RFC64_VM_AUTHOR,
      1,
    );
    const vmGraph = contextGraphLayerUri(
      RFC64_VM_CONTEXT_GRAPH_NAME,
      MemoryLayer.VerifiableMemory,
      RFC64_VM_AUTHOR,
      1,
    );
    const metaGraph = contextGraphMetaUri(RFC64_VM_CONTEXT_GRAPH_NAME);
    const predecessorGraph: Quad[] = [{
      subject: 'urn:rfc64:precommit-roster-change:old',
      predicate: 'urn:rfc64:value',
      object: '"old"',
      graph: vmGraph,
    }];
    const predecessorMetadata: Quad[] = [{
      subject: rfc64VmUal(1n),
      predicate: 'urn:rfc64:precommit-roster-change-marker',
      object: '"old"',
      graph: metaGraph,
    }];
    await store.insert(graphlessProjection.map((quad) => ({ ...quad, graph: swmGraph })));
    await store.insert([...predecessorGraph, ...predecessorMetadata]);
    const storeMaterializer = createFinalizedVmStoreMaterializerV1({ store });
    const rollback = vi.fn((cause?: unknown) => storeMaterializer.rollback(cause));
    const materialize = Object.assign(
      async (...args: Parameters<typeof storeMaterializer>) => {
        const receipt = await storeMaterializer(...args);
        rosterChanged = true;
        return receipt;
      },
      {
        commit: () => storeMaterializer.commit(),
        rollback,
      },
    );
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...options,
      acceptedPolicySnapshotForCatalogScope,
      rpcEndpoints: [await liveRpcEndpoint(assertionRoot)],
      materialize,
    });

    await expect(handler(Object.freeze({
      ...plan(),
      policyDigest: RFC64_VM_POLICY_DIGEST,
      rows: Object.freeze([placement]),
    }), new AbortController().signal)).rejects.toThrow(
      /accepted policy or roster changed during catalog precommit/u,
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(acceptedPolicySnapshotForCatalogScope).toHaveBeenCalledTimes(2);
    await expect(readExactGraphPaged(store, vmGraph, {
      expectedQuadCount: predecessorGraph.length,
      outputGraph: vmGraph,
    })).resolves.toEqual(predecessorGraph);
    await expect(store.query(
      `SELECT ?predicate ?object WHERE { GRAPH <${metaGraph}> { `
        + `<${rfc64VmUal(1n)}> ?predicate ?object } } ORDER BY ?predicate ?object`,
    )).resolves.toEqual({
      type: 'bindings',
      bindings: predecessorMetadata.map(({ predicate, object }) => ({ predicate, object })),
    });
  });

  it('rolls back exactly once when runtime materialization fails', async () => {
    const graphlessProjection: Quad[] = [{
      subject: 'urn:rfc64:precommit-materialization-failure',
      predicate: 'urn:rfc64:value',
      object: '"new"',
      graph: '',
    }];
    const assertionRoot = ethers.hexlify(computeFlatKCRootV10(
      graphlessProjection,
      [],
    )).toLowerCase() as Digest32V1;
    const placement = await createRfc64FinalizedVmPlacementFixture({
      assertionRoot,
      publicTripleCount: graphlessProjection.length,
    });
    const failure = new Error('injected finalized VM materialization failure');
    const rollback = vi.fn(async () => {});
    const materialize = Object.assign(
      vi.fn(async () => { throw failure; }),
      { commit: vi.fn(async () => {}), rollback },
    );
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      acceptedPolicySnapshotForCatalogScope: () => privateFinalizedSnapshot(),
      rpcEndpoints: [await liveRpcEndpoint(assertionRoot)],
      materialize,
    });

    await expect(handler(Object.freeze({
      ...plan(),
      rows: Object.freeze([placement]),
    }), new AbortController().signal)).rejects.toThrow(
      /materializer failed at finalized ordinal/u,
    );
    expect(materialize).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith(expect.any(Error));
  });

  it('canonicalizes chain-service scalar responses at the precommit boundary', async () => {
    const noncanonicalContextGraphId = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId: async () => '01',
    });
    await expect(
      noncanonicalContextGraphId(plan(), new AbortController().signal),
    ).rejects.toThrow('on-chain context graph id must be a canonical unsigned decimal');

    const noncanonicalKnowledgeAssetStorage = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getKnowledgeAssetStorageAddress: async () => '0x1234',
    });
    await expect(
      noncanonicalKnowledgeAssetStorage(plan(), new AbortController().signal),
    ).rejects.toThrow('knowledge asset storage address must be a lowercase 20-byte');

    const noncanonicalKnowledgeAssetsLifecycle = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getKnowledgeAssetsLifecycleAddress: async () => '0x1234',
    });
    await expect(
      noncanonicalKnowledgeAssetsLifecycle(plan(), new AbortController().signal),
    ).rejects.toThrow('knowledge assets lifecycle address must be a lowercase 20-byte');
  });
});
