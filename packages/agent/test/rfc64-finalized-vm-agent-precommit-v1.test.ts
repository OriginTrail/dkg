import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type AuthorCatalogScopeV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import type { Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 } from '../src/rfc64/public-catalog-native-receiver-v1.js';
import {
  RFC64_VM_AUTHOR,
  RFC64_VM_BLOCK_HASH,
  RFC64_VM_CG_STORAGE,
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_NETWORK_ID,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
} from './support/rfc64-finalized-vm-placement-fixture.js';

const CATALOG_HEAD_DIGEST = `0x${'91'.repeat(32)}` as Digest32V1;
const INVENTORY_DIGEST = `0x${'92'.repeat(32)}` as Digest32V1;

describe('RFC-64 finalized VM agent precommit', () => {
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
});

function baseOptions() {
  return {
    acceptedPolicySnapshotForCatalogScope: () => acceptedPolicy(),
    rpcEndpoints: ['http://127.0.0.1:8545'],
    getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    getEvmChainId: async () => BigInt(RFC64_VM_CHAIN_ID),
    getKnowledgeAssetStorageAddress: async () => RFC64_VM_KA_STORAGE,
    store: new OxigraphStore(),
  } as const;
}

function plan(): Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1> {
  return Object.freeze({
    catalogScope: Object.freeze({
      networkId: RFC64_VM_NETWORK_ID,
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      governanceChainId: RFC64_VM_CHAIN_ID,
      governanceContractAddress: RFC64_VM_CG_STORAGE,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: RFC64_VM_AUTHOR,
      era: '0',
      bucketCount: '1',
    } satisfies AuthorCatalogScopeV1),
    catalogHeadDigest: CATALOG_HEAD_DIGEST,
    inventoryDigest: INVENTORY_DIGEST,
    rows: Object.freeze([]),
  });
}

function acceptedPolicy(): AcceptedRfc64CatalogAccessSnapshotV1 {
  const policy = Object.freeze({
    networkId: RFC64_VM_NETWORK_ID,
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    governanceChainId: RFC64_VM_CHAIN_ID,
    governanceContractAddress: RFC64_VM_CG_STORAGE,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain',
      chainId: RFC64_VM_CHAIN_ID,
      contractAddress: RFC64_VM_CG_STORAGE,
      blockNumber: '123',
      blockHash: RFC64_VM_BLOCK_HASH,
    },
    effectiveAt: '1700000000000',
    issuedAt: '1700000000000',
  } satisfies ContextGraphPolicyV1);
  return Object.freeze({
    policy,
    policyDigest: RFC64_VM_POLICY_DIGEST,
    roster: null,
  });
}
