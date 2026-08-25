import type { MemberRosterV1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import { FinalizedVmCompositionErrorV1 } from '../src/rfc64/finalized-vm-composer-v1.js';
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

function finalizedChainFixture(): FinalizedVmLoopbackFixtureConfigV1 {
  return {
    accessPolicy: 1,
    active: true,
    assertedAtChainId: RFC64_VM_CHAIN_ID,
    assertedAtKav10Address: RFC64_VM_KAV10,
    knowledgeAssetStorageAddress: RFC64_VM_KA_STORAGE,
    assets: [{
      assertionRoot: RFC64_VM_ASSERTION_ROOT,
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

async function liveRpcEndpoint(): Promise<string> {
  const rpc = createFinalizedVmLoopbackRpcV1(finalizedChainFixture());
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
  it('rejects named-subgraph recovery before chain resolution in Release 2', async () => {
    const getOnChainContextGraphId = vi.fn(async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID);
    const getEvmChainId = vi.fn(async () => BigInt(RFC64_VM_CHAIN_ID));
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      getOnChainContextGraphId,
      getEvmChainId,
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
    const placement = await createRfc64FinalizedVmPlacementFixture();
    const initial = privateFinalizedSnapshot();
    const changed = privateFinalizedSnapshot('1700000000001');
    const acceptedPolicySnapshotForCatalogScope = vi.fn()
      .mockReturnValueOnce(initial)
      .mockReturnValue(changed);
    const materialize = vi.fn(async ({ candidate }: {
      candidate: { kaId: string; ordinal: string; ual: string };
    }) => ({
      kaId: candidate.kaId,
      ordinal: candidate.ordinal,
      ual: candidate.ual,
      status: 'materialized' as const,
      vmGraphIri: `${rfc64VmUal(1n)}/VerifiableMemory/2`,
      tripleCount: '10' as const,
      postReadDigest: `0x${'ee'.repeat(32)}` as const,
    }));
    const handler = createRfc64FinalizedVmAgentPrecommitV1({
      ...baseOptions(),
      acceptedPolicySnapshotForCatalogScope,
      rpcEndpoints: [await liveRpcEndpoint()],
      materialize: materialize as never,
    });

    await expect(handler(Object.freeze({
      ...plan(),
      policyDigest: RFC64_VM_POLICY_DIGEST,
      rows: Object.freeze([placement]),
    }), new AbortController().signal)).rejects.toThrow(
      /accepted policy or roster changed during catalog precommit/u,
    );
    expect(materialize).toHaveBeenCalledOnce();
    expect(acceptedPolicySnapshotForCatalogScope).toHaveBeenCalledTimes(2);
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
