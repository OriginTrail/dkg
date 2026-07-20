import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WAL_V1_ENUMS,
  decodeMoveTierSourceV1,
  decodeMoveTierTargetV1,
  decodeTierTransitionReceiptV1,
  encodeMoveTierSourceV1,
  encodeMoveTierTargetV1,
  encodeTierTransitionReceiptV1,
  createMoveTierTargetV1,
  moveTierCommitmentV1,
  targetMutationDigestV1,
  verifyMoveTierOpeningV1,
  verifyTierTransitionReceiptBindingV1,
  assertMoveTierPublicDisclosureSafeV1,
  vmBytesEqualV1,
  walVmError,
  type ProtocolTuple,
} from '../../src/index.js';

function bytes(label: string, length = 32): Uint8Array {
  const digest = createHash('sha256').update('wal-vm-test-v1\0' + label).digest();
  return new Uint8Array(digest.subarray(0, length));
}

function chainBinding(
  overrides: Partial<Record<number, bigint | Uint8Array>> = {},
): ProtocolTuple<'ChainBindingV1'> {
  const value: unknown[] = [
    2043n,
    bytes('contract', 20),
    bytes('context-graph'),
    bytes('ka'),
    bytes('author', 20),
    1n,
    bytes('root'),
    bytes('transaction'),
    21_000_000n,
    bytes('block'),
    2n,
    3n,
    BigInt(WAL_V1_ENUMS.chainEventType.PUBLISH),
    64n,
  ];
  for (const [index, replacement] of Object.entries(overrides)) {
    value[Number(index)] = replacement;
  }
  return value as unknown as ProtocolTuple<'ChainBindingV1'>;
}

function rdfMutation(
  audit: Uint8Array | null = null,
): ProtocolTuple<'RdfMutationV1'> {
  return [
    1n,
    BigInt(WAL_V1_ENUMS.mutationMode.PATCH),
    bytes('base-state'),
    bytes('result-state'),
    [],
    [],
    new Uint8Array(),
    new TextEncoder().encode('<urn:s> <urn:p> "v" <urn:g> .\n'),
    [bytes('touched-key')],
    audit,
  ];
}

function targetMutation(
  options: {
    operation?: bigint;
    binding?: ProtocolTuple<'ChainBindingV1'> | null;
    audit?: Uint8Array | null;
  } = {},
): ProtocolTuple<'DkgMutationV1'> {
  return [
    1n,
    options.operation ?? BigInt(WAL_V1_ENUMS.mutationOperation.MOVE_TIER_TARGET),
    bytes('logical-key'),
    [],
    [],
    bytes('policy'),
    rdfMutation(options.audit ?? null),
    options.binding === undefined ? chainBinding() : options.binding,
    null,
    null,
  ];
}

function transition() {
  const sourceNamespaceId = bytes('source-namespace');
  const targetNamespaceId = bytes('target-namespace');
  const targetWalObjectId = bytes('target-object');
  const mutation = targetMutation();
  const sourceStateDigest = bytes('source-state');
  const sourceResultDigest = bytes('source-result');
  const transitionNonce = bytes('nonce');
  const commitment = moveTierCommitmentV1({
    transitionNonce,
    sourceNamespaceId,
    targetNamespaceId,
    targetMutation: mutation,
    sourceStateDigest,
    sourceResultDigest,
  });
  const target = createMoveTierTargetV1(commitment, mutation);
  const source: ProtocolTuple<'MoveTierSourceV1'> = [
    1n,
    transitionNonce,
    commitment,
    targetNamespaceId,
    targetWalObjectId,
    [bytes('source-head')],
    sourceStateDigest,
    sourceResultDigest,
  ];
  return {
    sourceNamespaceId,
    targetNamespaceId,
    targetWalObjectId,
    mutation,
    target,
    source,
    commitment,
  };
}

function receipt(
  value: ReturnType<typeof transition>,
  overrides: Partial<Record<number, bigint | Uint8Array>> = {},
): ProtocolTuple<'TierTransitionReceiptV1'> {
  const tuple: unknown[] = [
    1n,
    value.commitment,
    value.targetNamespaceId,
    value.targetWalObjectId,
    value.mutation[5],
    bytes('vector'),
    2_000_000n,
    bytes('authority'),
    [[bytes('curator', 20), new Uint8Array(65).fill(1)]],
  ];
  for (const [index, replacement] of Object.entries(overrides)) {
    tuple[Number(index)] = replacement;
  }
  return tuple as unknown as ProtocolTuple<'TierTransitionReceiptV1'>;
}

describe('WAL-v1 MOVE_TIER protocol', () => {
  it('round-trips the two opaque sides and threshold receipt canonically', () => {
    const value = transition();
    const signedReceipt = receipt(value);

    expect(decodeMoveTierTargetV1(encodeMoveTierTargetV1(value.target))).toEqual(value.target);
    expect(decodeMoveTierSourceV1(encodeMoveTierSourceV1(value.source))).toEqual(value.source);
    expect(
      decodeTierTransitionReceiptV1(encodeTierTransitionReceiptV1(signedReceipt)),
    ).toEqual(signedReceipt);
    expect(targetMutationDigestV1(value.mutation)).toHaveLength(32);
  });

  it('opens the randomized commitment only with exact source and target coordinates', () => {
    const value = transition();
    expect(verifyMoveTierOpeningV1(value)).toEqual({
      chainBinding: value.mutation[7],
    });

    const wrongObject = { ...value, targetWalObjectId: bytes('wrong-target') };
    expect(() => verifyMoveTierOpeningV1(wrongObject)).toThrowError(
      expect.objectContaining({ code: 'WAL_VM_BINDING_MISMATCH' }),
    );
    const changedSource = [...value.source] as unknown[];
    changedSource[1] = bytes('changed-nonce');
    expect(() => verifyMoveTierOpeningV1({
      ...value,
      source: changedSource as unknown as ProtocolTuple<'MoveTierSourceV1'>,
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_BINDING_MISMATCH' }));
    const changedCommitment = [...value.source] as unknown[];
    changedCommitment[2] = bytes('different-commitment');
    expect(() => verifyMoveTierOpeningV1({
      ...value,
      source: changedCommitment as unknown as ProtocolTuple<'MoveTierSourceV1'>,
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_BINDING_MISMATCH' }));
  });

  it('rejects a same-view move, a non-tier operation, missing evidence, and audit leakage', () => {
    const sourceNamespaceId = bytes('same-namespace');
    expect(() => moveTierCommitmentV1({
      transitionNonce: bytes('nonce'),
      sourceNamespaceId,
      targetNamespaceId: sourceNamespaceId,
      targetMutation: targetMutation(),
      sourceStateDigest: bytes('state'),
      sourceResultDigest: bytes('result'),
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));

    expect(() => targetMutationDigestV1(targetMutation({
      operation: BigInt(WAL_V1_ENUMS.mutationOperation.PUT),
    }))).toThrowError(expect.objectContaining({ code: 'WAL_VM_WRONG_OPERATION' }));
    expect(() => targetMutationDigestV1(targetMutation({ binding: null })))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    const missingRdf = [...targetMutation()] as unknown[];
    missingRdf[6] = null;
    expect(() => targetMutationDigestV1(
      missingRdf as unknown as ProtocolTuple<'DkgMutationV1'>,
    )).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => targetMutationDigestV1(targetMutation({ audit: bytes('private-audit') })))
      .toThrowError(expect.objectContaining({ code: 'WAL_VM_PRIVATE_DISCLOSURE' }));
    expect(() => moveTierCommitmentV1({
      transitionNonce: new Uint8Array(31),
      sourceNamespaceId: bytes('source'),
      targetNamespaceId: bytes('target'),
      targetMutation: targetMutation(),
      sourceStateDigest: bytes('state'),
      sourceResultDigest: bytes('result'),
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(vmBytesEqualV1(new Uint8Array(), Uint8Array.of(1))).toBe(false);
  });

  it('binds the receipt to the exact public object, policy, vector, and lifetime', () => {
    const value = transition();
    const signedReceipt = receipt(value);
    expect(() => verifyTierTransitionReceiptBindingV1({
      targetNamespaceId: value.targetNamespaceId,
      targetWalObjectId: value.targetWalObjectId,
      target: value.target,
      receipt: signedReceipt,
      expectedCuratorVectorId: bytes('vector'),
      nowMs: 2_000_000,
    })).not.toThrow();

    for (const [index, replacement] of [
      [1, bytes('wrong-commitment')],
      [2, bytes('wrong-namespace')],
      [3, bytes('wrong-object')],
      [4, bytes('wrong-policy')],
      [5, bytes('wrong-vector')],
    ] as const) {
      expect(() => verifyTierTransitionReceiptBindingV1({
        targetNamespaceId: value.targetNamespaceId,
        targetWalObjectId: value.targetWalObjectId,
        target: value.target,
        receipt: receipt(value, { [index]: replacement }),
        expectedCuratorVectorId: bytes('vector'),
        nowMs: 1,
      })).toThrowError(expect.objectContaining({ code: 'WAL_VM_BINDING_MISMATCH' }));
    }
    expect(() => verifyTierTransitionReceiptBindingV1({
      targetNamespaceId: value.targetNamespaceId,
      targetWalObjectId: value.targetWalObjectId,
      target: value.target,
      receipt: signedReceipt,
      nowMs: 2_000_001,
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => verifyTierTransitionReceiptBindingV1({
      targetNamespaceId: value.targetNamespaceId,
      targetWalObjectId: value.targetWalObjectId,
      target: value.target,
      receipt: signedReceipt,
      nowMs: -1,
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
    expect(() => verifyTierTransitionReceiptBindingV1({
      targetNamespaceId: value.targetNamespaceId,
      targetWalObjectId: value.targetWalObjectId,
      target: value.target,
      receipt: receipt(value, { 6: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
      nowMs: 1,
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
  });

  it('detects exact private source representations in public target bytes', () => {
    const value = transition();
    expect(() => assertMoveTierPublicDisclosureSafeV1({
      target: value.target,
      privateValues: [
        value.sourceNamespaceId,
        value.source[1],
        value.source[5][0]!,
        value.source[6],
        value.source[7],
      ],
    })).not.toThrow();
    expect(() => assertMoveTierPublicDisclosureSafeV1({
      target: value.target,
      privateValues: [value.mutation[2]],
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_PRIVATE_DISCLOSURE' }));
    expect(() => assertMoveTierPublicDisclosureSafeV1({
      target: value.target,
      privateValues: [new Uint8Array(), new Uint8Array(4_096)],
    })).not.toThrow();
    expect(() => assertMoveTierPublicDisclosureSafeV1({
      target: value.target,
      privateValues: ['not-bytes' as unknown as Uint8Array],
    })).toThrowError(expect.objectContaining({ code: 'WAL_VM_INVALID' }));
  });

  it('preserves an explicit VM protocol error cause', () => {
    const cause = new Error('underlying');
    expect(() => walVmError('WAL_VM_INVALID', 'wrapped', cause)).toThrowError(
      expect.objectContaining({ code: 'WAL_VM_INVALID', cause }),
    );
  });
});
