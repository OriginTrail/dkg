import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { StrictCurrentFinalizedEvmSnapshotScopeV1 } from '@origintrail-official/dkg-chain';
import { proveRegisteredPrivateEmptyVmV1 } from '../src/rfc64/registered-private-empty-vm-proof-v1.js';
import {
  RFC64_VM_AUTHOR, RFC64_VM_BLOCK_HASH, RFC64_VM_CG_STORAGE, RFC64_VM_CHAIN_ID,
  RFC64_VM_CONTEXT_GRAPH_NAME, RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
} from './support/rfc64-finalized-vm-placement-fixture.js';

const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(RFC64_VM_CONTEXT_GRAPH_NAME));
const HUB = `0x${'88'.repeat(20)}`;
const OTHER = `0x${'77'.repeat(20)}`;
const storage = new ethers.Interface([
  'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getNameHash(uint256 contextGraphId) view returns (bytes32)',
  'function getContextGraphKaCount(uint256 contextGraphId) view returns (uint256)',
]);
const hub = new ethers.Interface(['function getAssetStorageAddress(string assetStorageName) view returns (address)']);

function snapshot(options: {
  kaCount?: bigint; nameHash?: string; active?: boolean; accessPolicy?: number;
  members?: readonly string[]; storageAddress?: string;
} = {}) {
  const methods: string[] = [];
  const scope: StrictCurrentFinalizedEvmSnapshotScopeV1 = async ({ chainId }, consume) => {
    expect(chainId).toBe(RFC64_VM_CHAIN_ID);
    return consume({
      chainId: RFC64_VM_CHAIN_ID, blockNumber: '123', blockHash: RFC64_VM_BLOCK_HASH,
      read: async (calls) => calls.map(({ to, data }) => {
        if (to === HUB) {
          const call = hub.parseTransaction({ data })!;
          methods.push(call.name);
          return hub.encodeFunctionResult(call.name, [options.storageAddress ?? RFC64_VM_CG_STORAGE]);
        }
        expect(to).toBe(RFC64_VM_CG_STORAGE);
        const call = storage.parseTransaction({ data })!;
        expect(call.args[0]).toBe(BigInt(RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID));
        methods.push(call.name);
        switch (call.name) {
          case 'getContextGraph': return storage.encodeFunctionResult(call.name, [
            RFC64_VM_AUTHOR, options.members ?? [RFC64_VM_AUTHOR], 0n,
            options.active ?? true, 1n, options.accessPolicy ?? 1,
            1, ethers.ZeroAddress, 0n,
          ]);
          case 'getNameHash': return storage.encodeFunctionResult(call.name, [options.nameHash ?? NAME_HASH]);
          case 'getContextGraphKaCount': return storage.encodeFunctionResult(call.name, [options.kaCount ?? 0n]);
          default: throw new Error(`unexpected method ${call.name}`);
        }
      }),
    });
  };
  return { scope, methods };
}

function request(scope: StrictCurrentFinalizedEvmSnapshotScopeV1) {
  return {
    contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
    onChainContextGraphId: RFC64_VM_ON_CHAIN_CONTEXT_GRAPH_ID,
    callerAgentAddress: RFC64_VM_AUTHOR,
    chainId: RFC64_VM_CHAIN_ID,
    hubAddress: HUB,
    governanceContractAddress: RFC64_VM_CG_STORAGE,
    snapshot: scope,
    signal: new AbortController().signal,
  } as const;
}

describe('registered private empty-VM proof', () => {
  it('accepts only current Hub binding, member, name, private policy, and zero inventory at one anchor', async () => {
    const view = snapshot();
    expect(await proveRegisteredPrivateEmptyVmV1(request(view.scope))).toBe(true);
    expect(view.methods).toEqual([
      'getContextGraph', 'getNameHash', 'getContextGraphKaCount', 'getAssetStorageAddress',
    ]);
  });

  it.each([
    [{ kaCount: 1n }, 'nonempty VM'],
    [{ nameHash: ethers.ZeroHash }, 'unrelated name'],
    [{ active: false }, 'inactive graph'],
    [{ accessPolicy: 0 }, 'public graph'],
    [{ members: [OTHER] }, 'caller absent from chain roster'],
    [{ storageAddress: OTHER }, 'rotated Hub binding'],
  ] as const)('rejects %s (%s)', async (options) => {
    expect(await proveRegisteredPrivateEmptyVmV1(request(snapshot(options).scope))).toBe(false);
  });
});
