import { describe, expect, it, vi } from 'vitest';

import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1,
  FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1,
  createFinalizedContextGraphRpcResolverV1,
} from '../src/finalized-context-graph-rpc-resolver.js';
import {
  resolveFinalizedContextGraphReadV1,
  type FinalizedContextGraphBindingV1,
} from '../src/finalized-context-graph-read.js';
import { type StrictCurrentFinalizedEvmReadV1 } from '../src/strict-current-finalized-evm-rpc.js';

const CHAIN_ID = '20430' as ChainIdV1;
const STORAGE = `0x${'11'.repeat(20)}` as EvmAddressV1;
const OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const PARTICIPANT = `0x${'44'.repeat(20)}`;
const BLOCK_HASH = `0x${'55'.repeat(32)}` as Digest32V1;
const NAME_HASH = `0x${'66'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const GET_CONTEXT_GRAPH_SELECTOR = '0xca22fff5';
const GET_NAME_HASH_SELECTOR = '0x8ce6a5c1';
const ENCODED_ID_42 = `${'0'.repeat(62)}2a`;

const ABI = ethers.AbiCoder.defaultAbiCoder();

function binding(): FinalizedContextGraphBindingV1 {
  return Object.freeze({
    chainId: CHAIN_ID,
    contextGraphId: '42',
    governanceContract: STORAGE,
  });
}

function contextGraphResult(overrides: {
  owner?: string;
  active?: boolean;
  accessPolicy?: number;
  publishPolicy?: number;
  publishAuthority?: string;
  publishAuthorityAccountId?: bigint;
} = {}): string {
  return ABI.encode(
    ['address', 'address[]', 'uint256', 'bool', 'uint256', 'uint8', 'uint8', 'address', 'uint256'],
    [
      overrides.owner ?? OWNER,
      [PARTICIPANT],
      9n,
      overrides.active ?? true,
      123n,
      overrides.accessPolicy ?? 1,
      overrides.publishPolicy ?? 0,
      overrides.publishAuthority ?? AUTHORITY,
      overrides.publishAuthorityAccountId ?? 7n,
    ],
  );
}

function nameHashResult(value = NAME_HASH): string {
  return ABI.encode(['bytes32'], [value]);
}

function readStub(
  tuple = contextGraphResult(),
  nameHash = nameHashResult(),
  resultChainId: ChainIdV1 = CHAIN_ID,
): ReturnType<typeof vi.fn<StrictCurrentFinalizedEvmReadV1>> {
  return vi.fn<StrictCurrentFinalizedEvmReadV1>(async () => Object.freeze({
    chainId: resultChainId,
    blockNumber: '123' as BlockNumberV1,
    blockHash: BLOCK_HASH,
    returnData: Object.freeze([tuple, nameHash]),
  }));
}

describe('RFC-64 finalized Context Graph RPC resolver', () => {
  it('executes the two ABI reads at one transport anchor and decodes the policy tuple', async () => {
    const read = readStub();
    const resolver = createFinalizedContextGraphRpcResolverV1(read);
    const signal = new AbortController().signal;

    const raw = await resolver(binding(), signal);

    expect(Object.isFrozen(resolver)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({
      chainId: CHAIN_ID,
      calls: [
        {
          to: STORAGE,
          data: `${GET_CONTEXT_GRAPH_SELECTOR}${ENCODED_ID_42}`,
          maxReturnBytes: FINALIZED_CONTEXT_GRAPH_TUPLE_MAX_RETURN_BYTES_V1,
        },
        {
          to: STORAGE,
          data: `${GET_NAME_HASH_SELECTOR}${ENCODED_ID_42}`,
          maxReturnBytes: FINALIZED_CONTEXT_GRAPH_NAME_HASH_MAX_RETURN_BYTES_V1,
        },
      ],
      signal,
    });
    expect(raw).toEqual({
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: '7',
      nameHash: NAME_HASH,
    });
  });

  it('feeds the concrete RPC result through the validated finalized read seam', async () => {
    const resolver = createFinalizedContextGraphRpcResolverV1(readStub());
    const result = await resolveFinalizedContextGraphReadV1(resolver, binding());

    expect(result).toEqual({
      ...binding(),
      blockNumber: '123',
      blockHash: BLOCK_HASH,
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: '7',
      nameHash: NAME_HASH,
    });
  });

  it('preserves the chain zero-hash sentinel for canonical null normalization', async () => {
    const resolver = createFinalizedContextGraphRpcResolverV1(
      readStub(contextGraphResult({
        publishPolicy: 1,
        publishAuthority: ethers.ZeroAddress,
        publishAuthorityAccountId: 0n,
      }), nameHashResult(ZERO_HASH)),
    );

    const result = await resolveFinalizedContextGraphReadV1(resolver, binding());
    expect(result.publishAuthority).toBeNull();
    expect(result.publishAuthorityAccountId).toBe('0');
    expect(result.nameHash).toBeNull();
  });

  it('rejects a transport result from a different chain', async () => {
    const resolver = createFinalizedContextGraphRpcResolverV1(
      readStub(contextGraphResult(), nameHashResult(), '1' as ChainIdV1),
    );
    await expect(resolver(binding())).rejects.toMatchObject({ code: 'chain-mismatch' });
  });

  it('rejects missing, trailing, or non-canonical ABI result bytes', async () => {
    const cases = [
      readStub('0x', nameHashResult()),
      readStub(`${contextGraphResult()}00`, nameHashResult()),
      readStub(contextGraphResult(), `${nameHashResult()}00`),
    ];
    for (const read of cases) {
      const resolver = createFinalizedContextGraphRpcResolverV1(read);
      await expect(resolver(binding())).rejects.toMatchObject({ code: 'malformed-return' });
    }
  });

  it('rejects any transport shape other than exactly two results', async () => {
    const read = vi.fn<StrictCurrentFinalizedEvmReadV1>(async () => ({
      chainId: CHAIN_ID,
      blockNumber: '123' as BlockNumberV1,
      blockHash: BLOCK_HASH,
      returnData: [contextGraphResult()],
    }));
    const resolver = createFinalizedContextGraphRpcResolverV1(read);
    await expect(resolver(binding())).rejects.toMatchObject({ code: 'malformed-return' });
  });

  it('rejects a non-function transport at construction', () => {
    expect(() => createFinalizedContextGraphRpcResolverV1(null as never)).toThrow(TypeError);
  });
});
