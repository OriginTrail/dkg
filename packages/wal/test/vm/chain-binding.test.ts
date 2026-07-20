import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WAL_V1_ENUMS,
  effectiveVmFinalityBlocksV1,
  isVmChainBindingFinalV1,
  validateVmChainBindingV1,
  vmChainConfirmationsV1,
  type CurrentVmFinalityPolicyV1,
  type ProtocolTuple,
} from '../../src/index.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(
    createHash('sha256').update('wal-vm-chain-test-v1\0' + label).digest().subarray(0, length),
  );
}

function binding(
  overrides: Partial<Record<number, bigint | Uint8Array>> = {},
): ProtocolTuple<'ChainBindingV1'> {
  const tuple: unknown[] = [
    2043n,
    bytes('contract', 20),
    bytes('cg'),
    bytes('ka'),
    bytes('author', 20),
    1n,
    bytes('root'),
    bytes('tx'),
    100n,
    bytes('block'),
    2n,
    3n,
    BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH),
    0n,
  ];
  for (const [index, replacement] of Object.entries(overrides)) {
    tuple[Number(index)] = replacement;
  }
  return tuple as unknown as ProtocolTuple<'ChainBindingV1'>;
}

function policy(overrides: Partial<CurrentVmFinalityPolicyV1> = {}): CurrentVmFinalityPolicyV1 {
  return {
    policyObjectId: bytes('policy'),
    minimumBlocks: 64n,
    maximumBlocks: 256n,
    ...overrides,
  };
}

describe('WAL-v1 VM chain binding and finality arithmetic', () => {
  it('accepts complete publish and update evidence shapes', () => {
    expect(() => validateVmChainBindingV1(binding())).not.toThrow();
    expect(() => validateVmChainBindingV1(binding({
      12: BigInt(WAL_V1_ENUMS.chainEventType.UPDATE),
    }))).not.toThrow();
  });

  it.each([
    [0, 0n],
    [1, new Uint8Array(20)],
    [2, new Uint8Array(32)],
    [3, new Uint8Array(32)],
    [5, 0n],
    [6, new Uint8Array(32)],
    [7, new Uint8Array(32)],
    [8, 0n],
    [9, new Uint8Array(32)],
  ] as const)('rejects zero-required identity field %s', (index, replacement) => {
    expect(() => validateVmChainBindingV1(binding({ [index]: replacement })))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
  });

  it('uses max(author request, network minimum) and rejects above the signed maximum', () => {
    expect(effectiveVmFinalityBlocksV1(binding({ 13: 0n }), policy())).toBe(64n);
    expect(effectiveVmFinalityBlocksV1(binding({ 13: 128n }), policy())).toBe(128n);
    expect(effectiveVmFinalityBlocksV1(binding({ 13: 64n }), policy({
      minimumBlocks: 128n,
    }))).toBe(128n);
    expect(() => effectiveVmFinalityBlocksV1(binding({ 13: 257n }), policy()))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_FINALITY_POLICY' }));
    expect(() => effectiveVmFinalityBlocksV1(binding(), policy({
      minimumBlocks: 257n,
      maximumBlocks: 256n,
    }))).toThrowError(expect.objectContaining({ code: 'WAL_VM_FINALITY_POLICY' }));
    for (const invalid of [
      policy({ policyObjectId: new Uint8Array(31) }),
      policy({ minimumBlocks: -1n }),
      policy({ maximumBlocks: 0x1_0000_0000n }),
    ]) {
      expect(() => effectiveVmFinalityBlocksV1(binding(), invalid))
        .toThrowError(expect.objectContaining({ code: 'WAL_VM_FINALITY_POLICY' }));
    }
  });

  it('requires both canonical block identity and effective depth', () => {
    const value = binding({ 13: 128n });
    expect(isVmChainBindingFinalV1(value, 227n, value[9], policy())).toBe(false);
    expect(isVmChainBindingFinalV1(value, 228n, value[9], policy())).toBe(true);
    expect(isVmChainBindingFinalV1(value, 500n, bytes('reorged-block'), policy())).toBe(false);
  });

  it('computes depth without underflow and rejects invalid local inputs', () => {
    expect(vmChainConfirmationsV1(99n, 100n)).toBe(0n);
    expect(vmChainConfirmationsV1(164n, 100n)).toBe(64n);
    expect(() => vmChainConfirmationsV1(-1n, 0n))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => vmChainConfirmationsV1(0n, -1n))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => isVmChainBindingFinalV1(binding(), 200n, new Uint8Array(31), policy()))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => isVmChainBindingFinalV1(
      binding(),
      200n,
      'not-bytes' as unknown as Uint8Array,
      policy(),
    )).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
  });
});
