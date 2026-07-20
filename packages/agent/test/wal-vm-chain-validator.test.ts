import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChainAdapter, ChainEvent } from '@origintrail-official/dkg-chain';
import {
  WAL_V1_ENUMS,
  type ProtocolTuple,
} from '@origintrail-official/dkg-wal';
import type { CurrentVmFinalityPolicyV1 } from '@origintrail-official/dkg-wal/vm';
import { ethers } from 'ethers';
import {
  validateCurrentDkgVmChainEvidenceV1,
} from '../src/semantic/vm-chain-validator.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update('agent-vm-chain-v1\0' + label).digest().subarray(0, length),
  );
}

function bigintBytes(value: bigint): Uint8Array {
  const output = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function binding(
  overrides: Partial<Record<number, bigint | Uint8Array>> = {},
): ProtocolTuple<'ChainBindingV1'> {
  const tuple: unknown[] = [
    2043n,
    bytes('contract', 20),
    bigintBytes(7n),
    bigintBytes(9n),
    bytes('author', 20),
    2n,
    bytes('root'),
    bytes('tx'),
    100n,
    bytes('block'),
    4n,
    5n,
    BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH),
    64n,
  ];
  for (const [index, replacement] of Object.entries(overrides)) {
    tuple[Number(index)] = replacement;
  }
  return tuple as unknown as ProtocolTuple<'ChainBindingV1'>;
}

function policy(): CurrentVmFinalityPolicyV1 {
  return {
    policyObjectId: bytes('policy'),
    minimumBlocks: 64n,
    maximumBlocks: 256n,
  };
}

function event(
  value: ProtocolTuple<'ChainBindingV1'>,
  overrides: Record<string, unknown> = {},
): ChainEvent {
  return {
    type: value[12] === BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH)
      ? 'KCCreated'
      : 'KnowledgeAssetUpdated',
    blockNumber: Number(value[8]),
    data: {
      kaId: '9',
      merkleRoot: ethers.hexlify(value[6]),
      txHash: ethers.hexlify(value[7]),
      txIndex: Number(value[10]),
      logIndex: Number(value[11]),
      blockHash: ethers.hexlify(value[9]),
      author: ethers.getAddress(ethers.hexlify(value[4])),
      ...overrides,
    },
  };
}

function chain(
  value: ProtocolTuple<'ChainBindingV1'>,
  overrides: Partial<{
    chainId: bigint;
    contract: string;
    contextGraphId: bigint;
    merkleRoot: Uint8Array;
    assertionVersion: bigint;
    author: string;
    head: number;
    events: ChainEvent[];
    throwRead: boolean;
    capabilities: boolean;
  }> = {},
): ChainAdapter {
  const capabilities = overrides.capabilities ?? true;
  const throwIfNeeded = () => {
    if (overrides.throwRead) throw new Error('rpc unavailable');
  };
  return {
    chainType: 'evm',
    chainId: 'otp:2043',
    deploymentId: 'otp:2043:test',
    getEvmChainId: async () => {
      throwIfNeeded();
      return overrides.chainId ?? value[0];
    },
    getDKGKnowledgeAssetsAddress: capabilities
      ? async () => overrides.contract ?? ethers.getAddress(ethers.hexlify(value[1]))
      : undefined,
    getKAContextGraphId: capabilities
      ? async () => overrides.contextGraphId ?? 7n
      : undefined,
    getLatestMerkleRoot: capabilities
      ? async () => overrides.merkleRoot ?? value[6]
      : undefined,
    getMerkleRootCount: capabilities
      ? async () => overrides.assertionVersion ?? value[5]
      : undefined,
    getLatestMerkleRootAuthor: capabilities
      ? async () => overrides.author ?? ethers.getAddress(ethers.hexlify(value[4]))
      : undefined,
    getBlockNumber: capabilities
      ? async () => overrides.head ?? 164
      : undefined,
    listenForEvents: async function* () {
      for (const item of overrides.events ?? [event(value)]) yield item;
    },
  } as unknown as ChainAdapter;
}

describe('shared DKG VM chain validator', () => {
  it('finalizes exact publish and update evidence at effective depth', async () => {
    const publish = binding();
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(publish),
      binding: publish,
      finalityPolicy: policy(),
    })).resolves.toEqual({
      status: 'FINALIZED',
      reason: 'VERIFIED_FINAL',
      effectiveFinalityBlocks: 64n,
      confirmations: 64n,
      verifiedFrontier: [publish[0], publish[8], publish[9]],
    });

    const update = binding({
      12: BigInt(WAL_V1_ENUMS.chainEventType.UPDATE),
      13: 128n,
    });
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(update, { head: 228, events: [event(update)] }),
      binding: update,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({
      status: 'FINALIZED',
      effectiveFinalityBlocks: 128n,
      confirmations: 128n,
    });
  });

  it('keeps unavailable and insufficiently buried evidence pending', async () => {
    const value = binding();
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(value, { head: 163 }),
      binding: value,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({
      status: 'PENDING',
      reason: 'INSUFFICIENT_FINALITY',
      confirmations: 63n,
    });
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(value, { capabilities: false }),
      binding: value,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({ status: 'PENDING', reason: 'CHAIN_UNAVAILABLE' });
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(value, { throwRead: true }),
      binding: value,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({ status: 'PENDING', reason: 'CHAIN_UNAVAILABLE' });
  });

  it.each([
    ['chain id', { chainId: 2044n }, 'CHAIN_ID_MISMATCH'],
    ['contract', { contract: ethers.ZeroAddress }, 'CONTRACT_MISMATCH'],
    ['context graph', { contextGraphId: 8n }, 'CONTEXT_GRAPH_MISMATCH'],
    ['root', { merkleRoot: bytes('wrong-root') }, 'MERKLE_ROOT_MISMATCH'],
    ['version', { assertionVersion: 3n }, 'ASSERTION_VERSION_MISMATCH'],
    ['author', { author: ethers.ZeroAddress }, 'AUTHOR_MISMATCH'],
  ] as const)('rejects substituted current %s truth', async (_name, overrides, reason) => {
    const value = binding();
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(value, overrides),
      binding: value,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({ status: 'REJECTED', reason });
  });

  it.each([
    ['KA', { kaId: '10' }, 'KA_ID_MISMATCH'],
    ['event root', { merkleRoot: ethers.hexlify(bytes('wrong-event-root')) }, 'MERKLE_ROOT_MISMATCH'],
    ['transaction', { txHash: ethers.hexlify(bytes('wrong-tx')) }, 'TRANSACTION_MISMATCH'],
    ['transaction index', { txIndex: 99 }, 'EVENT_LOCATION_MISMATCH'],
    ['log index', { logIndex: 99 }, 'EVENT_LOCATION_MISMATCH'],
    ['event author', { author: ethers.ZeroAddress }, 'AUTHOR_MISMATCH'],
  ] as const)('rejects substituted %s evidence', async (_name, eventOverrides, reason) => {
    const value = binding();
    await expect(validateCurrentDkgVmChainEvidenceV1({
      chain: chain(value, { events: [event(value, eventOverrides)] }),
      binding: value,
      finalityPolicy: policy(),
    })).resolves.toMatchObject({ status: 'REJECTED', reason });
  });

  it('turns a missing or changed canonical block into a reorg event', async () => {
    const value = binding();
    for (const events of [
      [],
      [event(value, { blockHash: ethers.hexlify(bytes('replacement-block')) })],
    ]) {
      await expect(validateCurrentDkgVmChainEvidenceV1({
        chain: chain(value, { events }),
        binding: value,
        finalityPolicy: policy(),
      })).resolves.toMatchObject({ status: 'REORG', reason: 'BLOCK_REORG' });
    }
  });
});
