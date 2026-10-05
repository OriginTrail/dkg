import { CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1, type ContextGraphPolicyV1, type MemberRosterV1 } from '@origintrail-official/dkg-core';
import type { StrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { proveRegisteredPrivateEmptyVmV1 } from '../src/rfc64/registered-private-empty-vm-proof-v1.js';
import {
  RFC64_VM_AUTHOR, RFC64_VM_BLOCK_HASH, RFC64_VM_CG_STORAGE, RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME, RFC64_VM_NETWORK_ID, RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
  RFC64_VM_POLICY_DIGEST,
} from './support/rfc64-finalized-vm-placement-fixture.js';

const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(RFC64_VM_CONTEXT_GRAPH_NAME));
const CG = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
]);

function accepted(): AcceptedRfc64CatalogAccessSnapshotV1 {
  const policy = {
    networkId: RFC64_VM_NETWORK_ID,
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    governanceChainId: RFC64_VM_CHAIN_ID,
    governanceContractAddress: RFC64_VM_CG_STORAGE,
    ownershipTransitionDigest: null,
    era: '0', version: '0', previousPolicyDigest: null,
    accessPolicy: 1, publishPolicy: 1,
    publishAuthority: null, publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'finalized-chain', chainId: RFC64_VM_CHAIN_ID,
      contractAddress: RFC64_VM_CG_STORAGE,
      blockNumber: '123', blockHash: RFC64_VM_BLOCK_HASH,
    },
    effectiveAt: '1700000000000', issuedAt: '1700000000000',
  } satisfies ContextGraphPolicyV1;
  const roster = {
    networkId: policy.networkId, contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: policy.ownershipTransitionDigest,
    era: policy.era, version: '0', previousRosterDigest: null,
    policyDigest: RFC64_VM_POLICY_DIGEST,
    administrativeDelegationDigest: policy.administrativeDelegationDigest,
    members: [{ agentAddress: RFC64_VM_AUTHOR, roles: ['provider'] }],
    issuedAt: '1700000000000',
  } satisfies MemberRosterV1;
  return { policy, policyDigest: RFC64_VM_POLICY_DIGEST, roster };
}

function snapshot(options: { kaCount?: bigint; nameHash?: string; active?: boolean } = {}) {
  const methods: string[] = [];
  const scope: StrictCurrentFinalizedEvmSnapshotScopeV1 = async ({ chainId }, consume) => {
    expect(chainId).toBe(RFC64_VM_CHAIN_ID);
    return consume({
      chainId: RFC64_VM_CHAIN_ID, blockNumber: '123', blockHash: RFC64_VM_BLOCK_HASH,
      read: async (calls) => calls.map(({ to, data }) => {
        expect(to).toBe(RFC64_VM_CG_STORAGE);
        const id = CG.parseTransaction({ data })!;
        expect(id.args[0]).toBe(BigInt(RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID));
        methods.push(id.name);
        switch (id.name) {
          case 'getContextGraph': return CG.encodeFunctionResult(id.name, [
            RFC64_VM_AUTHOR, [], 0n, options.active ?? true, 1n, 1, 1, ethers.ZeroAddress, 0n,
          ]);
          case 'getNameHash': return CG.encodeFunctionResult(id.name, [options.nameHash ?? NAME_HASH]);
          case 'getContextGraphKaCount': return CG.encodeFunctionResult(id.name, [options.kaCount ?? 0n]);
          default: throw new Error(`unexpected method ${id.name}`);
        }
      }),
    });
  };
  return { scope, methods };
}

function request(scope: StrictCurrentFinalizedEvmSnapshotScopeV1, held = accepted()) {
  return {
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    onChainContextGraphId: RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    callerAgentAddress: RFC64_VM_AUTHOR,
    accepted: held, snapshot: scope,
    signal: new AbortController().signal,
  } as const;
}

describe('registered private empty-VM proof', () => {
  it('accepts a roster member only when policy/name and zero inventory share a finalized snapshot', async () => {
    const view = snapshot();
    expect(await proveRegisteredPrivateEmptyVmV1(request(view.scope))).toBe(true);
    expect(view.methods).toEqual(['getContextGraph', 'getNameHash', 'getContextGraphKaCount']);
  });

  it('rejects a nonempty finalized inventory', async () => {
    expect(await proveRegisteredPrivateEmptyVmV1(request(snapshot({ kaCount: 1n }).scope))).toBe(false);
  });

  it('rejects an unrelated finalized name or inactive graph', async () => {
    await expect(proveRegisteredPrivateEmptyVmV1(request(snapshot({ nameHash: ethers.ZeroHash }).scope)))
      .rejects.toThrow('accepted policy or cleartext name binding differs');
    await expect(proveRegisteredPrivateEmptyVmV1(request(snapshot({ active: false }).scope)))
      .rejects.toThrow('accepted policy or cleartext name binding differs');
  });

  it('refuses a private caller missing from the accepted policy-bound roster', async () => {
    const held = accepted();
    expect(await proveRegisteredPrivateEmptyVmV1(request(snapshot().scope, {
      ...held, roster: { ...held.roster!, members: [] },
    }))).toBe(false);
  });
});
