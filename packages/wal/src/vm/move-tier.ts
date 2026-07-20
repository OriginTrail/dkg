import { compareCanonicalCbor } from '../protocol/canonical-cbor.js';
import {
  decodeProtocolTuple,
  encodeProtocolTuple,
  validateProtocolTuple,
} from '../protocol/codec.js';
import { hashWalV1Domain } from '../protocol/hashes.js';
import {
  WAL_V1_ENUMS,
  type ProtocolTuple,
} from '../protocol/schema.js';
import { walVmError } from './errors.js';
import type {
  MoveTierCommitmentInputV1,
  MoveTierPublicDisclosureInputV1,
  VerifyMoveTierOpeningInputV1,
  VerifyTierTransitionReceiptBindingInputV1,
} from './types.js';

const MOVE_TIER_TARGET = BigInt(WAL_V1_ENUMS.mutationOperation.MOVE_TIER_TARGET);

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function fixed32(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    walVmError('WAL_VM_INVALID', label + ' must be exactly 32 bytes');
  }
  return copy(value);
}

export function vmBytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function assertTargetMutation(
  mutation: ProtocolTuple<'DkgMutationV1'>,
): ProtocolTuple<'ChainBindingV1'> {
  validateProtocolTuple('DkgMutationV1', mutation);
  if (mutation[1] !== MOVE_TIER_TARGET) {
    walVmError(
      'WAL_VM_WRONG_OPERATION',
      'MoveTierTargetV1 must carry a MOVE_TIER_TARGET DkgMutationV1',
    );
  }
  if (mutation[6] === null || mutation[7] === null) {
    walVmError(
      'WAL_VM_INVALID',
      'MOVE_TIER_TARGET requires both an RDF outcome and ChainBindingV1',
    );
  }
  if (mutation[6][9] !== null) {
    walVmError(
      'WAL_VM_PRIVATE_DISCLOSURE',
      'public MOVE_TIER_TARGET must not carry source semantic audit bytes',
    );
  }
  return mutation[7];
}

export function targetMutationDigestV1(
  mutation: ProtocolTuple<'DkgMutationV1'>,
): Uint8Array {
  assertTargetMutation(mutation);
  return hashWalV1Domain(
    'moveTierTargetMutation',
    encodeProtocolTuple('DkgMutationV1', mutation),
  );
}

export function moveTierCommitmentV1(
  input: MoveTierCommitmentInputV1,
): Uint8Array {
  const transitionNonce = fixed32(input.transitionNonce, 'transitionNonce');
  const sourceNamespaceId = fixed32(input.sourceNamespaceId, 'sourceNamespaceId');
  const targetNamespaceId = fixed32(input.targetNamespaceId, 'targetNamespaceId');
  if (vmBytesEqualV1(sourceNamespaceId, targetNamespaceId)) {
    walVmError('WAL_VM_INVALID', 'MOVE_TIER source and target namespaces must differ');
  }
  return hashWalV1Domain(
    'moveTierCommitment',
    transitionNonce,
    sourceNamespaceId,
    targetNamespaceId,
    targetMutationDigestV1(input.targetMutation),
    fixed32(input.sourceStateDigest, 'sourceStateDigest'),
    fixed32(input.sourceResultDigest, 'sourceResultDigest'),
  );
}

export function createMoveTierTargetV1(
  transitionCommitment: Uint8Array,
  targetMutation: ProtocolTuple<'DkgMutationV1'>,
): ProtocolTuple<'MoveTierTargetV1'> {
  assertTargetMutation(targetMutation);
  const value = [
    1n,
    fixed32(transitionCommitment, 'transitionCommitment'),
    targetMutation,
  ] as const;
  validateProtocolTuple('MoveTierTargetV1', value);
  return value;
}

export function encodeMoveTierTargetV1(
  value: ProtocolTuple<'MoveTierTargetV1'>,
): Uint8Array {
  assertTargetMutation(value[2]);
  return encodeProtocolTuple('MoveTierTargetV1', value);
}

export function decodeMoveTierTargetV1(
  bytes: Uint8Array,
): ProtocolTuple<'MoveTierTargetV1'> {
  const value = decodeProtocolTuple('MoveTierTargetV1', bytes);
  assertTargetMutation(value[2]);
  return value;
}

export function encodeMoveTierSourceV1(
  value: ProtocolTuple<'MoveTierSourceV1'>,
): Uint8Array {
  return encodeProtocolTuple('MoveTierSourceV1', value);
}

export function decodeMoveTierSourceV1(
  bytes: Uint8Array,
): ProtocolTuple<'MoveTierSourceV1'> {
  return decodeProtocolTuple('MoveTierSourceV1', bytes);
}

export function encodeTierTransitionReceiptV1(
  value: ProtocolTuple<'TierTransitionReceiptV1'>,
): Uint8Array {
  return encodeProtocolTuple('TierTransitionReceiptV1', value);
}

export function decodeTierTransitionReceiptV1(
  bytes: Uint8Array,
): ProtocolTuple<'TierTransitionReceiptV1'> {
  return decodeProtocolTuple('TierTransitionReceiptV1', bytes);
}

export function verifyMoveTierOpeningV1(
  input: VerifyMoveTierOpeningInputV1,
): { readonly chainBinding: ProtocolTuple<'ChainBindingV1'> } {
  validateProtocolTuple('MoveTierTargetV1', input.target);
  validateProtocolTuple('MoveTierSourceV1', input.source);
  const sourceNamespaceId = fixed32(input.sourceNamespaceId, 'sourceNamespaceId');
  const targetNamespaceId = fixed32(input.targetNamespaceId, 'targetNamespaceId');
  const targetWalObjectId = fixed32(input.targetWalObjectId, 'targetWalObjectId');
  if (
    !vmBytesEqualV1(input.source[3], targetNamespaceId)
    || !vmBytesEqualV1(input.source[4], targetWalObjectId)
  ) {
    walVmError(
      'WAL_VM_BINDING_MISMATCH',
      'private MOVE_TIER source opening names another target',
    );
  }
  if (!vmBytesEqualV1(input.source[2], input.target[1])) {
    walVmError(
      'WAL_VM_BINDING_MISMATCH',
      'MOVE_TIER source and target commitments differ',
    );
  }
  const computed = moveTierCommitmentV1({
    transitionNonce: input.source[1],
    sourceNamespaceId,
    targetNamespaceId,
    targetMutation: input.target[2],
    sourceStateDigest: input.source[6],
    sourceResultDigest: input.source[7],
  });
  if (!vmBytesEqualV1(computed, input.target[1])) {
    walVmError(
      'WAL_VM_BINDING_MISMATCH',
      'MOVE_TIER opening does not reproduce the public commitment',
    );
  }
  return { chainBinding: assertTargetMutation(input.target[2]) };
}

export function verifyTierTransitionReceiptBindingV1(
  input: VerifyTierTransitionReceiptBindingInputV1,
): void {
  validateProtocolTuple('MoveTierTargetV1', input.target);
  validateProtocolTuple('TierTransitionReceiptV1', input.receipt);
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    walVmError('WAL_VM_INVALID', 'receipt evaluation time must be a safe integer');
  }
  const targetNamespaceId = fixed32(input.targetNamespaceId, 'targetNamespaceId');
  const targetWalObjectId = fixed32(input.targetWalObjectId, 'targetWalObjectId');
  if (
    !vmBytesEqualV1(input.receipt[1], input.target[1])
    || !vmBytesEqualV1(input.receipt[2], targetNamespaceId)
    || !vmBytesEqualV1(input.receipt[3], targetWalObjectId)
    || !vmBytesEqualV1(input.receipt[4], input.target[2][5])
  ) {
    walVmError(
      'WAL_VM_BINDING_MISMATCH',
      'tier receipt does not bind the target, commitment, and policy',
    );
  }
  if (
    input.expectedCuratorVectorId !== undefined
    && !vmBytesEqualV1(
      input.receipt[5],
      fixed32(input.expectedCuratorVectorId, 'expectedCuratorVectorId'),
    )
  ) {
    walVmError(
      'WAL_VM_BINDING_MISMATCH',
      'tier receipt references another curator vector',
    );
  }
  if (
    input.receipt[6] > BigInt(Number.MAX_SAFE_INTEGER)
    || BigInt(input.nowMs) > input.receipt[6]
  ) {
    walVmError('WAL_VM_INVALID', 'tier-transition receipt is expired');
  }
}

export function assertMoveTierPublicDisclosureSafeV1(
  input: MoveTierPublicDisclosureInputV1,
): void {
  const publicBytes = encodeMoveTierTargetV1(input.target);
  const values = [...input.privateValues].sort(compareCanonicalCbor);
  for (const [index, value] of values.entries()) {
    if (!(value instanceof Uint8Array)) {
      walVmError('WAL_VM_INVALID', 'privateValues[' + index + '] must be bytes');
    }
    if (includesBytes(publicBytes, value)) {
      walVmError(
        'WAL_VM_PRIVATE_DISCLOSURE',
        'public MOVE_TIER target contains private source value ' + index,
      );
    }
  }
}
