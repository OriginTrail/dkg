import { describe, expect, it } from 'vitest';

import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
  EvmAddressV1,
} from '@origintrail-official/dkg-core';

import {
  FINALIZED_CG_POLICY_SNAPSHOT_SCHEMA_V1,
  FinalizedContextGraphPolicyErrorV1,
  createFixedFinalizedContextGraphPolicyResolverV1,
  resolveFinalizedContextGraphPolicySnapshotV1,
  snapshotFinalizedContextGraphPolicyV1,
  type FinalizedContextGraphPolicyErrorCodeV1,
  type FinalizedContextGraphPolicyRequestV1,
  type RawFinalizedContextGraphPolicyFieldsV1,
} from '../src/finalized-context-graph-policy-snapshot.js';

const CHAIN_ID = '20430' as ChainIdV1;
const CGS = `0x${'11'.repeat(20)}` as EvmAddressV1;
const OWNER = `0x${'22'.repeat(20)}` as EvmAddressV1;
const AUTHORITY = `0x${'33'.repeat(20)}` as EvmAddressV1;
const ZERO = `0x${'0'.repeat(40)}` as EvmAddressV1;
const BLOCK_HASH = `0x${'44'.repeat(32)}` as Digest32V1;
const NAME_HASH = `0x${'55'.repeat(32)}` as Digest32V1;

function validRequest(): FinalizedContextGraphPolicyRequestV1 {
  return { chainId: CHAIN_ID, contextGraphId: '42', governanceContract: CGS };
}

function validRaw(): RawFinalizedContextGraphPolicyFieldsV1 {
  return {
    blockNumber: '123' as BlockNumberV1,
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

function expectFailure(operation: () => unknown, code: FinalizedContextGraphPolicyErrorCodeV1): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FinalizedContextGraphPolicyErrorV1);
    expect((error as FinalizedContextGraphPolicyErrorV1).code).toBe(code);
    return;
  }
  throw new Error(`expected failure ${code}`);
}

describe('RFC-64 Gate 5 finalized Context Graph policy snapshot', () => {
  it('composes an immutable snapshot binding anchor, identity, and every policy field', () => {
    const snapshot = snapshotFinalizedContextGraphPolicyV1(validRequest(), validRaw());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({
      schema: FINALIZED_CG_POLICY_SNAPSHOT_SCHEMA_V1,
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

  it('reaches the same snapshot through the resolver seam (mock-adapter parity)', async () => {
    const resolver = createFixedFinalizedContextGraphPolicyResolverV1(validRaw());
    const viaSeam = await resolveFinalizedContextGraphPolicySnapshotV1(resolver, validRequest());
    const direct = snapshotFinalizedContextGraphPolicyV1(validRequest(), validRaw());
    expect(viaSeam).toEqual(direct);
  });

  it('accepts a zero publish authority (curator/PCA unset) without inventing one', () => {
    const snapshot = snapshotFinalizedContextGraphPolicyV1(validRequest(), {
      ...validRaw(),
      publishAuthority: ZERO,
      publishAuthorityAccountId: '0',
    });
    expect(snapshot.publishAuthority).toBe(ZERO);
    expect(snapshot.publishAuthorityAccountId).toBe('0');
  });

  it('accepts a registered-but-inactive Context Graph', () => {
    const snapshot = snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), active: false });
    expect(snapshot.active).toBe(false);
  });

  it('fails closed on an unregistered context graph (zero owner)', () => {
    expectFailure(
      () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), owner: ZERO }),
      'unregistered-context-graph',
    );
  });

  it.each([
    ['non-canonical chainId', () => snapshotFinalizedContextGraphPolicyV1({ ...validRequest(), chainId: '020430' as ChainIdV1 }, validRaw()), 'request-binding'],
    ['non-decimal contextGraphId', () => snapshotFinalizedContextGraphPolicyV1({ ...validRequest(), contextGraphId: '0x2a' }, validRaw()), 'request-binding'],
    ['zero governanceContract', () => snapshotFinalizedContextGraphPolicyV1({ ...validRequest(), governanceContract: ZERO }, validRaw()), 'request-binding'],
    ['checksummed (non-lowercase) owner', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), owner: `0x${'Ab'.repeat(20)}` as EvmAddressV1 }), 'malformed-owner'],
    ['malformed publishAuthority', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), publishAuthority: '0xdeadbeef' as EvmAddressV1 }), 'malformed-authority'],
    ['out-of-range accessPolicy', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), accessPolicy: 2 }), 'unsupported-access-policy'],
    ['out-of-range publishPolicy', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), publishPolicy: 9 }), 'unsupported-publish-policy'],
    ['malformed blockHash', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), blockHash: '0xdead' as Digest32V1 }), 'malformed-anchor'],
    ['non-decimal blockNumber', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), blockNumber: 'latest' as unknown as BlockNumberV1 }), 'request-binding'],
    ['malformed nameHash', () => snapshotFinalizedContextGraphPolicyV1(validRequest(), { ...validRaw(), nameHash: '0x55' as Digest32V1 }), 'malformed-name-binding'],
  ] as const)('fails closed on %s', (_name, operation, code) => {
    expectFailure(operation, code);
  });
});
