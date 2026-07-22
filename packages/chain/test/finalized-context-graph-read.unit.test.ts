import { describe, expect, it, vi } from 'vitest';

import type {
  ContextGraphAccessPolicyV1,
  ContextGraphPublishPolicyV1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  FinalizedContextGraphReadErrorV1,
  composeFinalizedContextGraphReadV1,
  resolveFinalizedContextGraphReadWithSignalV1,
  resolveFinalizedContextGraphReadV1,
  type FinalizedContextGraphBindingV1,
  type FinalizedContextGraphReadErrorCodeV1,
  type FinalizedContextGraphReadRequestV1,
  type FinalizedContextGraphReadResolverV1,
  type FinalizedContextGraphReadResolverWithSignalV1,
  type UntrustedFinalizedContextGraphFieldsV1,
} from '../src/finalized-context-graph-read.js';

const CHAIN_ID = '20430';
const CGS = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const NAME_HASH = `0x${'55'.repeat(32)}`;
const MAX_U64 = '18446744073709551615';
const ABOVE_MAX_U64 = '18446744073709551616';
const MAX_U256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const ABOVE_MAX_U256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639936';

function validRequest(): FinalizedContextGraphReadRequestV1 {
  return { chainId: CHAIN_ID, contextGraphId: '42', governanceContract: CGS };
}

function validRaw(): UntrustedFinalizedContextGraphFieldsV1 {
  return {
    blockNumber: '123',
    blockHash: BLOCK_HASH,
    owner: OWNER,
    active: true,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: '7',
    nameHash: NAME_HASH,
  };
}

function expectFailure(
  operation: () => unknown,
  code: FinalizedContextGraphReadErrorCodeV1,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FinalizedContextGraphReadErrorV1);
    expect((error as FinalizedContextGraphReadErrorV1).code).toBe(code);
    return;
  }
  throw new Error(`expected failure ${code}`);
}

describe('RFC-64 finalized Context Graph chain read', () => {
  it('validates and snapshots the complete request-bound chain result', () => {
    const read = composeFinalizedContextGraphReadV1(validRequest(), validRaw());
    const accessPolicy: ContextGraphAccessPolicyV1 = read.accessPolicy;
    const publishPolicy: ContextGraphPublishPolicyV1 = read.publishPolicy;
    const publishAuthority: EvmAddressV1 | null = read.publishAuthority;
    expect(Object.isFrozen(read)).toBe(true);
    expect(accessPolicy).toBe(1);
    expect(publishPolicy).toBe(0);
    expect(publishAuthority).toBe(AUTHORITY);
    expect(read).toEqual({
      chainId: CHAIN_ID,
      contextGraphId: '42',
      governanceContract: CGS,
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

  it('passes one frozen canonical binding through the resolver seam', async () => {
    const request = validRequest();
    const raw = Object.freeze(validRaw());
    const resolver: FinalizedContextGraphReadResolverV1 = vi.fn((received) => {
      expect(received).not.toBe(request);
      expect(Object.isFrozen(received)).toBe(true);
      expect(received).toEqual(request);
      return Promise.resolve(raw);
    });
    const viaSeam = await resolveFinalizedContextGraphReadV1(resolver, request);
    const direct = composeFinalizedContextGraphReadV1(request, validRaw());
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(Object.freeze({
      chainId: CHAIN_ID,
      contextGraphId: '42',
      governanceContract: CGS,
    }));
    expect(viaSeam).toEqual(direct);
  });

  it('requires and forwards caller-owned cancellation for signal-aware resolvers', async () => {
    const request = validRequest();
    const raw = Object.freeze(validRaw());
    const signal = new AbortController().signal;
    const resolver: FinalizedContextGraphReadResolverWithSignalV1 = vi.fn(
      async () => raw,
    );

    const result = await resolveFinalizedContextGraphReadWithSignalV1(
      resolver,
      request,
      signal,
    );

    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(Object.freeze({
      chainId: CHAIN_ID,
      contextGraphId: '42',
      governanceContract: CGS,
    }), signal);
    expect(result).toEqual(composeFinalizedContextGraphReadV1(request, raw));
  });

  it('rejects malformed identity before invoking the resolver', async () => {
    const resolver = vi.fn(() => Promise.resolve(validRaw()));
    await expect(resolveFinalizedContextGraphReadV1(resolver, {
      ...validRequest(),
      contextGraphId: '0x2a',
    })).rejects.toMatchObject({ code: 'request-binding' });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('maps the valid open-policy zero authority to the canonical null domain', () => {
    const read = composeFinalizedContextGraphReadV1(validRequest(), {
      ...validRaw(),
      publishPolicy: 1,
      publishAuthority: ZERO,
      publishAuthorityAccountId: '0',
    });
    expect(read.publishAuthority).toBeNull();
    expect(read.publishAuthorityAccountId).toBe('0');
  });

  it('rejects a curated policy without a non-zero authority', () => {
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), {
        ...validRaw(),
        publishAuthority: ZERO,
        publishAuthorityAccountId: '0',
      }),
      'inconsistent-publish-policy',
    );
  });

  it('independently rejects both invalid fields in an open policy', () => {
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), {
        ...validRaw(),
        publishPolicy: 1,
        publishAuthorityAccountId: '0',
      }),
      'inconsistent-publish-policy',
    );
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), {
        ...validRaw(),
        publishPolicy: 1,
        publishAuthority: ZERO,
      }),
      'inconsistent-publish-policy',
    );
  });

  it('preserves a registered-but-inactive Context Graph as chain-read state', () => {
    const read = composeFinalizedContextGraphReadV1(validRequest(), {
      ...validRaw(),
      active: false,
    });
    expect(read.active).toBe(false);
  });

  it('maps both finalized name-hash opt-out representations to null', () => {
    const fromAdapter = composeFinalizedContextGraphReadV1(validRequest(), {
      ...validRaw(),
      nameHash: null,
    });
    const fromRawRpc = composeFinalizedContextGraphReadV1(validRequest(), {
      ...validRaw(),
      nameHash: `0x${'0'.repeat(64)}`,
    });
    expect(fromAdapter.nameHash).toBeNull();
    expect(fromRawRpc.nameHash).toBeNull();
  });

  it('accepts the canonical u64 block-number maximum and rejects MAX_U64 + 1', () => {
    const read = composeFinalizedContextGraphReadV1(validRequest(), {
      ...validRaw(),
      blockNumber: MAX_U64,
    });
    expect(read.blockNumber).toBe(MAX_U64);
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), {
        ...validRaw(),
        blockNumber: ABOVE_MAX_U64,
      }),
      'request-binding',
    );
  });

  it('accepts canonical u256 identity boundaries and rejects values above them', () => {
    const read = composeFinalizedContextGraphReadV1(
      { ...validRequest(), contextGraphId: MAX_U256 },
      { ...validRaw(), publishAuthorityAccountId: MAX_U256 },
    );
    expect(read.contextGraphId).toBe(MAX_U256);
    expect(read.publishAuthorityAccountId).toBe(MAX_U256);

    expectFailure(
      () => composeFinalizedContextGraphReadV1(
        { ...validRequest(), contextGraphId: ABOVE_MAX_U256 },
        validRaw(),
      ),
      'request-binding',
    );
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), {
        ...validRaw(),
        publishAuthorityAccountId: ABOVE_MAX_U256,
      }),
      'request-binding',
    );
  });

  it('fails closed on an unregistered context graph (zero owner)', () => {
    expectFailure(
      () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), owner: ZERO }),
      'unregistered-context-graph',
    );
  });

  it.each([
    ['non-canonical chainId', () => composeFinalizedContextGraphReadV1({ ...validRequest(), chainId: '020430' }, validRaw()), 'request-binding'],
    ['non-decimal contextGraphId', () => composeFinalizedContextGraphReadV1({ ...validRequest(), contextGraphId: '0x2a' }, validRaw()), 'request-binding'],
    ['zero governanceContract', () => composeFinalizedContextGraphReadV1({ ...validRequest(), governanceContract: ZERO }, validRaw()), 'request-binding'],
    ['checksummed owner', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), owner: `0x${'Ab'.repeat(20)}` }), 'malformed-owner'],
    ['malformed publishAuthority', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), publishAuthority: '0xdeadbeef' }), 'malformed-authority'],
    ['hex publishAuthorityAccountId', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), publishAuthorityAccountId: '0x7' }), 'request-binding'],
    ['non-canonical publishAuthorityAccountId', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), publishAuthorityAccountId: '07' }), 'request-binding'],
    ['out-of-range accessPolicy', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), accessPolicy: 2 }), 'unsupported-access-policy'],
    ['out-of-range publishPolicy', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), publishPolicy: 9 }), 'unsupported-publish-policy'],
    ['malformed blockHash', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), blockHash: '0xdead' }), 'malformed-anchor'],
    ['non-decimal blockNumber', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), blockNumber: 'latest' }), 'request-binding'],
    ['malformed active flag', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), active: 1 }), 'malformed-anchor'],
    ['malformed nameHash', () => composeFinalizedContextGraphReadV1(validRequest(), { ...validRaw(), nameHash: '0x55' }), 'malformed-name-binding'],
  ] as const)('fails closed on %s', (_name, operation, code) => {
    expectFailure(operation, code);
  });
});
