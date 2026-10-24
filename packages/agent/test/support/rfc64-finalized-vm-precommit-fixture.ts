/**
 * Shared fixtures for the RFC-64 finalized-VM agent precommit tests.
 *
 * Extracted because two suites need the same plan, accepted-policy snapshot and
 * base options while varying one field each — the shipped-pool regression only
 * varies `rpcEndpoints`. Keeping a second copy meant a change to the plan or
 * policy shape required synchronized edits across files before either suite's
 * actual assertion could run.
 *
 * The digests are exported so a caller can assert against them rather than
 * re-deriving the literals.
 */
import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type AuthorCatalogScopeV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../../src/rfc64/catalog-access-policy-v1.js';
import type { Rfc64FinalizedVmAgentPrecommitOptionsV1 } from '../../src/rfc64/finalized-vm-agent-precommit-v1.js';
import type { Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1 } from '../../src/rfc64/public-catalog-native-receiver-v1.js';
import {
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
} from './rfc64-finalized-vm-placement-fixture.js';

export const RFC64_VM_CATALOG_HEAD_DIGEST = `0x${'91'.repeat(32)}` as Digest32V1;
export const RFC64_VM_INVENTORY_DIGEST = `0x${'92'.repeat(32)}` as Digest32V1;

/** The before-applied-head commit plan the precommit is driven with. */
export function rfc64FinalizedVmPrecommitPlan():
Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1> {
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
    policyDigest: RFC64_VM_POLICY_DIGEST,
    catalogHeadDigest: RFC64_VM_CATALOG_HEAD_DIGEST,
    inventoryDigest: RFC64_VM_INVENTORY_DIGEST,
    rows: Object.freeze([]),
  });
}

/** One accepted, public, finalized-chain policy snapshot. */
export function acceptedRfc64VmPolicySnapshot(): AcceptedRfc64CatalogAccessSnapshotV1 {
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

/**
 * Base precommit options. Each suite overrides the one field it is about — a
 * single resolver for the noncanonical-input cases, `rpcEndpoints` for the
 * shipped-pool regression.
 *
 * A fresh `OxigraphStore` per call: sharing one across tests would let state
 * from an earlier case leak into a later assertion.
 *
 * Overrides are `Partial<Rfc64FinalizedVmAgentPrecommitOptionsV1>` rather than a
 * loose record, so a misspelled key or a wrongly-shaped value is a type error at
 * the call site that introduces it, not a silently-ignored property.
 */
export function rfc64FinalizedVmPrecommitOptions(
  overrides: Partial<Rfc64FinalizedVmAgentPrecommitOptionsV1> = {},
): Rfc64FinalizedVmAgentPrecommitOptionsV1 {
  return {
    acceptedPolicySnapshotForCatalogScope: () => acceptedRfc64VmPolicySnapshot(),
    rpcEndpoints: ['http://127.0.0.1:8545'],
    getOnChainContextGraphId: async () => RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    getEvmChainId: async () => BigInt(RFC64_VM_CHAIN_ID),
    getKnowledgeAssetStorageAddress: async () => RFC64_VM_KA_STORAGE,
    getKnowledgeAssetsLifecycleAddress: async () => RFC64_VM_KAV10,
    store: new OxigraphStore(),
    ...overrides,
  };
}
