import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type ContextGraphPolicyV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import type {
  StrictCurrentFinalizedEvmReadCallV1,
  StrictCurrentFinalizedEvmSnapshotScopeV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import {
  FinalizedVmRuntimeErrorV1,
  createFinalizedVmRuntimeV1,
  type FinalizedVmMaterializerV1,
} from '../src/rfc64/finalized-vm-runtime-v1.js';
import {
  RFC64_VM_ASSERTION_ROOT,
  RFC64_VM_AUTHOR,
  RFC64_VM_BLOCK_HASH,
  RFC64_VM_CG_STORAGE,
  RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME,
  RFC64_VM_KA_STORAGE,
  RFC64_VM_NETWORK_ID,
  RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
  RFC64_VM_PUBLISHER,
  createRfc64FinalizedVmPlacementFixture,
  rfc64VmPackKaId,
  rfc64VmUal,
} from './support/rfc64-finalized-vm-placement-fixture.js';

const OWNER = `0x${'aa'.repeat(20)}` as const;
const RECEIPT_DIGEST = `0x${'ee'.repeat(32)}` as Digest32V1;
const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(RFC64_VM_CONTEXT_GRAPH_NAME)).toLowerCase();
const CG = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function isContextGraphActive(uint256 contextGraphId) view returns (bool)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
  'function getContextGraphKaAt(uint256 contextGraphId, uint256 ordinal) view returns (uint256)',
]);
const KA = new ethers.Interface([
  'function getKnowledgeAssetUpdateContext(uint256 id) view returns (uint256 merkleRootsCount, uint256 minted, uint88 byteSize, uint40 endEpoch, uint96 tokenAmount, bool isImmutable, uint32 merkleLeafCount)',
  'function getLatestMerkleRoot(uint256 id) view returns (bytes32)',
  'function getLatestMerkleRootAuthor(uint256 id) view returns (address)',
  'function getLatestMerkleRootPublisher(uint256 id) view returns (address)',
]);

describe('RFC-64 finalized public VM runtime', () => {
  it('verifies one exact finalized view before materializing in ordinal order', async () => {
    const placement = await createRfc64FinalizedVmPlacementFixture();
    const transport = snapshotTransport();
    const materialize = vi.fn<FinalizedVmMaterializerV1>(async (request) => {
      expect(transport.isOpen()).toBe(false);
      expect(request.candidate.finalizedBlockHash).toBe(RFC64_VM_BLOCK_HASH);
      expect(request.finalizedContextGraph.blockHash).toBe(RFC64_VM_BLOCK_HASH);
      expect(Object.isFrozen(request)).toBe(true);
      return receipt();
    });
    const runtime = createFinalizedVmRuntimeV1(runtimeConfig(transport.snapshot, materialize));

    const result = await runtime(request(placement));

    expect(transport.reads()).toBe(4);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(result.composed.evidence).toMatchObject({
      rowCount: '1',
      highestFinalizedOrdinal: '0',
    });
    expect(result.receipts).toEqual([receipt()]);
    expect(result.acceptedPolicyDigest).toBe(RFC64_VM_POLICY_DIGEST);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipts)).toBe(true);
  });

  it('fails closed before store writes on name, policy, or placement mismatch', async () => {
    const placement = await createRfc64FinalizedVmPlacementFixture();
    const mutations = [
      { transport: { nameHash: `0x${'12'.repeat(32)}` }, policy: {} },
      { transport: {}, policy: { publishPolicy: 0, publishAuthority: RFC64_VM_PUBLISHER } },
      { transport: { assertionRoot: `0x${'13'.repeat(32)}` }, policy: {} },
    ] as const;
    for (const mutation of mutations) {
      const transport = snapshotTransport(mutation.transport);
      const materialize = vi.fn<FinalizedVmMaterializerV1>(async () => receipt());
      const runtime = createFinalizedVmRuntimeV1(runtimeConfig(transport.snapshot, materialize));
      const input = request(placement, mutation.policy);
      await expect(runtime(input)).rejects.toThrow();
      expect(materialize).not.toHaveBeenCalled();
    }
  });

  it('accepts an older still-current policy anchor but rejects a conflicting same-height hash', async () => {
    const placement = await createRfc64FinalizedVmPlacementFixture();
    const transport = snapshotTransport();
    const materialize = vi.fn<FinalizedVmMaterializerV1>(async () => receipt());
    const runtime = createFinalizedVmRuntimeV1(runtimeConfig(transport.snapshot, materialize));

    await expect(runtime(request(placement))).resolves.toBeDefined();
    await expect(runtime(request(placement, {}, {
      blockNumber: '123',
      blockHash: `0x${'14'.repeat(32)}`,
    }))).rejects.toMatchObject({ code: 'finalized-vm-runtime-policy' });
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched post-read receipt and reports the exact ordinal', async () => {
    const placement = await createRfc64FinalizedVmPlacementFixture();
    const transport = snapshotTransport();
    const runtime = createFinalizedVmRuntimeV1(runtimeConfig(
      transport.snapshot,
      async () => ({ ...receipt(), ordinal: '1' }),
    ));

    await expect(runtime(request(placement))).rejects.toMatchObject({
      code: 'finalized-vm-runtime-materialization',
    } satisfies Partial<FinalizedVmRuntimeErrorV1>);
  });
});

function runtimeConfig(
  snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1,
  materialize: FinalizedVmMaterializerV1,
) {
  return {
    networkId: RFC64_VM_NETWORK_ID,
    chainId: RFC64_VM_CHAIN_ID,
    contextGraphStorageAddress: RFC64_VM_CG_STORAGE,
    knowledgeAssetStorageAddress: RFC64_VM_KA_STORAGE,
    snapshot,
    materialize,
  } as const;
}

function request(
  placement: Awaited<ReturnType<typeof createRfc64FinalizedVmPlacementFixture>>,
  policyOverrides: Partial<ContextGraphPolicyV1> = {},
  sourceOverrides: Partial<Extract<ContextGraphPolicyV1['source'], { kind: 'finalized-chain' }>> = {},
) {
  const policy = publicPolicy(policyOverrides, sourceOverrides);
  return {
    catalogLane: { contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME, subGraphName: null },
    onChainContextGraphId: RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    acceptedPolicy: {
      policy,
      policyDigest: RFC64_VM_POLICY_DIGEST,
      roster: null,
    } satisfies AcceptedRfc64CatalogAccessSnapshotV1,
    placements: [placement],
    signal: new AbortController().signal,
  } as const;
}

function publicPolicy(
  overrides: Partial<ContextGraphPolicyV1>,
  sourceOverrides: Partial<Extract<ContextGraphPolicyV1['source'], { kind: 'finalized-chain' }>>,
): ContextGraphPolicyV1 {
  return {
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
      blockNumber: '120',
      blockHash: `0x${'76'.repeat(32)}`,
      ...sourceOverrides,
    },
    effectiveAt: '1700000000000',
    issuedAt: '1700000000000',
    ...overrides,
  };
}

function receipt() {
  return {
    kaId: rfc64VmPackKaId(1n),
    ordinal: '0',
    ual: rfc64VmUal(1n),
    status: 'materialized',
    vmGraphIri: `${rfc64VmUal(1n)}/VerifiableMemory/2`,
    tripleCount: '10',
    postReadDigest: RECEIPT_DIGEST,
  } as const;
}

function snapshotTransport(options: {
  readonly nameHash?: string;
  readonly assertionRoot?: string;
} = {}) {
  let open = false;
  let readCount = 0;
  const snapshot: StrictCurrentFinalizedEvmSnapshotScopeV1 = async (snapshotRequest, consume) => {
    expect(snapshotRequest.chainId).toBe(RFC64_VM_CHAIN_ID);
    open = true;
    try {
      return await consume(Object.freeze({
        chainId: RFC64_VM_CHAIN_ID,
        blockNumber: '123',
        blockHash: RFC64_VM_BLOCK_HASH,
        read: async (calls) => {
          if (!open) throw new Error('snapshot session escaped its scope');
          readCount += 1;
          return Object.freeze(calls.map(encodeCallResult));
        },
      }));
    } finally {
      open = false;
    }
  };
  return {
    snapshot,
    isOpen: () => open,
    reads: () => readCount,
  };

  function encodeCallResult(call: StrictCurrentFinalizedEvmReadCallV1): string {
    const selector = call.data.slice(0, 10);
    switch (selector) {
      case CG.getFunction('getContextGraph')!.selector:
        return CG.encodeFunctionResult('getContextGraph', [
          OWNER, [], 0n, true, 1n, 0, 1, ZERO_ADDRESS, 0n,
        ]);
      case CG.getFunction('getNameHash')!.selector:
        return CG.encodeFunctionResult('getNameHash', [options.nameHash ?? NAME_HASH]);
      case CG.getFunction('isContextGraphActive')!.selector:
        return CG.encodeFunctionResult('isContextGraphActive', [true]);
      case CG.getFunction('getContextGraphKaCount')!.selector:
        return CG.encodeFunctionResult('getContextGraphKaCount', [1n]);
      case CG.getFunction('getContextGraphKaAt')!.selector:
        return CG.encodeFunctionResult('getContextGraphKaAt', [BigInt(rfc64VmPackKaId(1n))]);
      case KA.getFunction('getKnowledgeAssetUpdateContext')!.selector:
        return KA.encodeFunctionResult('getKnowledgeAssetUpdateContext', [2n, 0n, 0n, 0n, 0n, false, 0]);
      case KA.getFunction('getLatestMerkleRoot')!.selector:
        return KA.encodeFunctionResult(
          'getLatestMerkleRoot',
          [options.assertionRoot ?? RFC64_VM_ASSERTION_ROOT],
        );
      case KA.getFunction('getLatestMerkleRootAuthor')!.selector:
        return KA.encodeFunctionResult('getLatestMerkleRootAuthor', [RFC64_VM_AUTHOR]);
      case KA.getFunction('getLatestMerkleRootPublisher')!.selector:
        return KA.encodeFunctionResult('getLatestMerkleRootPublisher', [RFC64_VM_PUBLISHER]);
      default:
        throw new Error(`unexpected finalized VM read ${selector}`);
    }
  }
}
