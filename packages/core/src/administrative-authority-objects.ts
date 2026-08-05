import {
  canonicalizeJson,
  parseCanonicalJson,
  type CanonicalJsonValue,
  type StrictJsonParseOptions,
} from './canonical-json.js';
import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  type ContextGraphIdV1,
  type NetworkIdV1,
} from './author-catalog-codec.js';
import {
  assertSignedControlEnvelope,
  assertUnsignedControlEnvelope,
  canonicalizeSignedControlEnvelopeBytes,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigestHex,
  parseCanonicalSignedControlEnvelope,
  parseCanonicalUnsignedControlEnvelope,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from './sync-control-object.js';
import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalTimestampMs,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type TimestampMsV1,
} from './sync-wire-scalars.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

export const CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1 = 'CgOwnershipTransitionV1' as const;
export const CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1 =
  'CgAdministrativeDelegationV1' as const;
export const CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1 =
  'CheckpointAuthorityDelegationV1' as const;
export const CG_OWNERSHIP_TRANSITION_MODE_V1 = 'chain-rebaseline-v1' as const;
export const MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1 = 16 * 1024;
export const MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_DEPTH_V1 = 3;
export const CG_ADMINISTRATIVE_DELEGATION_ROLES_V1 = Object.freeze([
  'checkpoint-delegation',
  'policy',
  'retention',
  'roster',
] as const);

export type CgAdministrativeDelegationRoleV1 =
  (typeof CG_ADMINISTRATIVE_DELEGATION_ROLES_V1)[number];

export interface FinalizedTransferPositionV1 {
  readonly blockNumber: DecimalU64V1;
  readonly blockHash: Digest32V1;
  readonly transactionHash: Digest32V1;
  readonly transactionIndex: DecimalU64V1;
  readonly logIndex: DecimalU64V1;
}

export interface FinalizedOwnershipTransferV1 extends FinalizedTransferPositionV1 {
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly previousOwnerAddress: EvmAddressV1;
  readonly newOwnerAddress: EvmAddressV1;
}

export interface CgOwnershipTransitionV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownershipEpoch: DecimalU64V1;
  readonly previousFinalizedTransfer: FinalizedTransferPositionV1 | null;
  readonly finalizedTransfer: FinalizedOwnershipTransferV1;
  readonly mode: typeof CG_OWNERSHIP_TRANSITION_MODE_V1;
  readonly issuedAt: TimestampMsV1;
}

export interface FinalizedChainOwnerSourceV1 {
  readonly kind: 'finalized-chain-owner';
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly blockNumber: DecimalU64V1;
  readonly blockHash: Digest32V1;
}

export interface OwnerSignedUnregisteredAdministrativeSourceV1 {
  readonly kind: 'owner-signed-unregistered';
  readonly ownerAuthorityEra: DecimalU64V1;
}

export type CgAdministrativeDelegationSourceV1 =
  | FinalizedChainOwnerSourceV1
  | OwnerSignedUnregisteredAdministrativeSourceV1;

export interface CgAdministrativeDelegationV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly adminEra: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly previousDelegationDigest: Digest32V1 | null;
  readonly ownerAddress: EvmAddressV1;
  readonly delegateAddress: EvmAddressV1;
  readonly roles: readonly CgAdministrativeDelegationRoleV1[];
  readonly source: CgAdministrativeDelegationSourceV1;
  readonly effectiveAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1;
}

export interface CheckpointAuthorityDelegationV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly authorityEpoch: DecimalU64V1;
  readonly previousDelegationDigest: Digest32V1 | null;
  readonly predecessorCheckpointDigest: Digest32V1 | null;
  readonly predecessorCheckpointVersion: DecimalU64V1 | null;
  readonly rebaselineTransitionDigest: Digest32V1 | null;
  readonly checkpointAuthorityAddress: EvmAddressV1;
  readonly standbyCheckpointAuthorityAddress: EvmAddressV1 | null;
  readonly administrativeDelegationDigest: Digest32V1 | null;
  readonly activatedAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1;
}

export type UnsignedCgOwnershipTransitionEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1;
  readonly payload: CgOwnershipTransitionV1;
};
export type SignedCgOwnershipTransitionEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1;
  readonly payload: CgOwnershipTransitionV1;
};
export type UnsignedCgAdministrativeDelegationEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: CgAdministrativeDelegationV1;
};
export type SignedCgAdministrativeDelegationEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: CgAdministrativeDelegationV1;
};
export type UnsignedCheckpointAuthorityDelegationEnvelopeV1 = UnsignedControlEnvelopeV1 & {
  readonly objectType: typeof CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: CheckpointAuthorityDelegationV1;
};
export type SignedCheckpointAuthorityDelegationEnvelopeV1 = SignedControlEnvelopeV1 & {
  readonly objectType: typeof CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1;
  readonly payload: CheckpointAuthorityDelegationV1;
};

export type AdministrativeAuthorityCodecErrorCode =
  | 'admin-authority-schema'
  | 'admin-authority-scalar'
  | 'admin-authority-type'
  | 'admin-authority-order'
  | 'admin-authority-role'
  | 'admin-authority-branch'
  | 'admin-authority-payload-too-large';

export class AdministrativeAuthorityCodecError extends Error {
  constructor(
    readonly code: AdministrativeAuthorityCodecErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AdministrativeAuthorityCodecError';
  }
}

export function assertCgOwnershipTransitionV1(
  value: unknown,
): asserts value is CgOwnershipTransitionV1 {
  validateCgOwnershipTransitionSnapshotV1(value);
}

export function canonicalizeCgOwnershipTransitionPayloadV1(
  value: CgOwnershipTransitionV1,
): string {
  return validateCgOwnershipTransitionSnapshotV1(value).canonical;
}

export function canonicalizeCgOwnershipTransitionPayloadBytesV1(
  value: CgOwnershipTransitionV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalizeCgOwnershipTransitionPayloadV1(value));
}

export function parseCanonicalCgOwnershipTransitionPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CgOwnershipTransitionV1 {
  return parsePayload(
    input,
    options,
    'CG ownership transition',
    validateCgOwnershipTransitionSnapshotV1,
  );
}

export function assertCgAdministrativeDelegationV1(
  value: unknown,
): asserts value is CgAdministrativeDelegationV1 {
  validateCgAdministrativeDelegationSnapshotV1(value);
}

export function canonicalizeCgAdministrativeDelegationPayloadV1(
  value: CgAdministrativeDelegationV1,
): string {
  return validateCgAdministrativeDelegationSnapshotV1(value).canonical;
}

export function canonicalizeCgAdministrativeDelegationPayloadBytesV1(
  value: CgAdministrativeDelegationV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalizeCgAdministrativeDelegationPayloadV1(value));
}

export function parseCanonicalCgAdministrativeDelegationPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CgAdministrativeDelegationV1 {
  return parsePayload(
    input,
    options,
    'CG administrative delegation',
    validateCgAdministrativeDelegationSnapshotV1,
  );
}

export function assertCheckpointAuthorityDelegationV1(
  value: unknown,
): asserts value is CheckpointAuthorityDelegationV1 {
  validateCheckpointAuthorityDelegationSnapshotV1(value);
}

export function canonicalizeCheckpointAuthorityDelegationPayloadV1(
  value: CheckpointAuthorityDelegationV1,
): string {
  return validateCheckpointAuthorityDelegationSnapshotV1(value).canonical;
}

export function canonicalizeCheckpointAuthorityDelegationPayloadBytesV1(
  value: CheckpointAuthorityDelegationV1,
): Uint8Array {
  return new TextEncoder().encode(canonicalizeCheckpointAuthorityDelegationPayloadV1(value));
}

export function parseCanonicalCheckpointAuthorityDelegationPayloadV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CheckpointAuthorityDelegationV1 {
  return parsePayload(
    input,
    options,
    'checkpoint-authority delegation',
    validateCheckpointAuthorityDelegationSnapshotV1,
  );
}

export function assertUnsignedCgOwnershipTransitionEnvelopeV1(
  value: unknown,
): asserts value is UnsignedCgOwnershipTransitionEnvelopeV1 {
  validateUnsignedEnvelopeSnapshot(
    value,
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  );
}

export function assertSignedCgOwnershipTransitionEnvelopeV1(
  value: unknown,
): asserts value is SignedCgOwnershipTransitionEnvelopeV1 {
  validateSignedEnvelopeSnapshot(
    value,
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  );
}

export function assertUnsignedCgAdministrativeDelegationEnvelopeV1(
  value: unknown,
): asserts value is UnsignedCgAdministrativeDelegationEnvelopeV1 {
  validateUnsignedEnvelopeSnapshot(
    value,
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  );
}

export function assertSignedCgAdministrativeDelegationEnvelopeV1(
  value: unknown,
): asserts value is SignedCgAdministrativeDelegationEnvelopeV1 {
  validateSignedEnvelopeSnapshot(
    value,
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  );
}

export function assertUnsignedCheckpointAuthorityDelegationEnvelopeV1(
  value: unknown,
): asserts value is UnsignedCheckpointAuthorityDelegationEnvelopeV1 {
  validateUnsignedEnvelopeSnapshot(
    value,
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  );
}

export function assertSignedCheckpointAuthorityDelegationEnvelopeV1(
  value: unknown,
): asserts value is SignedCheckpointAuthorityDelegationEnvelopeV1 {
  validateSignedEnvelopeSnapshot(
    value,
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  );
}

export function canonicalizeUnsignedCgOwnershipTransitionEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeUnsignedControlEnvelopeBytes(validateUnsignedEnvelopeSnapshot(
    value,
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  ));
}

export function canonicalizeSignedCgOwnershipTransitionEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeSignedControlEnvelopeBytes(validateSignedEnvelopeSnapshot(
    value,
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  ));
}

export function canonicalizeUnsignedCgAdministrativeDelegationEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeUnsignedControlEnvelopeBytes(validateUnsignedEnvelopeSnapshot(
    value,
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  ));
}

export function canonicalizeSignedCgAdministrativeDelegationEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeSignedControlEnvelopeBytes(validateSignedEnvelopeSnapshot(
    value,
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  ));
}

export function canonicalizeUnsignedCheckpointAuthorityDelegationEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeUnsignedControlEnvelopeBytes(validateUnsignedEnvelopeSnapshot(
    value,
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  ));
}

export function canonicalizeSignedCheckpointAuthorityDelegationEnvelopeBytesV1(
  value: unknown,
): Uint8Array {
  return canonicalizeSignedControlEnvelopeBytes(validateSignedEnvelopeSnapshot(
    value,
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  ));
}

export function computeCgOwnershipTransitionObjectDigestV1(value: unknown): Digest32V1 {
  return computeTypedObjectDigest(
    value,
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  );
}

export function computeCgAdministrativeDelegationObjectDigestV1(value: unknown): Digest32V1 {
  return computeTypedObjectDigest(
    value,
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  );
}

export function computeCheckpointAuthorityDelegationObjectDigestV1(value: unknown): Digest32V1 {
  return computeTypedObjectDigest(
    value,
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  );
}

export function parseCanonicalUnsignedCgOwnershipTransitionEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedCgOwnershipTransitionEnvelopeV1 {
  return validateUnsignedEnvelopeSnapshot(
    parseCanonicalUnsignedControlEnvelope(input, options),
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  ) as UnsignedCgOwnershipTransitionEnvelopeV1;
}

export function parseCanonicalSignedCgOwnershipTransitionEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedCgOwnershipTransitionEnvelopeV1 {
  return validateSignedEnvelopeSnapshot(
    parseCanonicalSignedControlEnvelope(input, options),
    CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1,
    validateCgOwnershipTransitionPlainV1,
  ) as SignedCgOwnershipTransitionEnvelopeV1;
}

export function parseCanonicalUnsignedCgAdministrativeDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedCgAdministrativeDelegationEnvelopeV1 {
  return validateUnsignedEnvelopeSnapshot(
    parseCanonicalUnsignedControlEnvelope(input, options),
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  ) as UnsignedCgAdministrativeDelegationEnvelopeV1;
}

export function parseCanonicalSignedCgAdministrativeDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedCgAdministrativeDelegationEnvelopeV1 {
  return validateSignedEnvelopeSnapshot(
    parseCanonicalSignedControlEnvelope(input, options),
    CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1,
    validateCgAdministrativeDelegationPlainV1,
  ) as SignedCgAdministrativeDelegationEnvelopeV1;
}

export function parseCanonicalUnsignedCheckpointAuthorityDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): UnsignedCheckpointAuthorityDelegationEnvelopeV1 {
  return validateUnsignedEnvelopeSnapshot(
    parseCanonicalUnsignedControlEnvelope(input, options),
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  ) as UnsignedCheckpointAuthorityDelegationEnvelopeV1;
}

export function parseCanonicalSignedCheckpointAuthorityDelegationEnvelopeV1(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): SignedCheckpointAuthorityDelegationEnvelopeV1 {
  return validateSignedEnvelopeSnapshot(
    parseCanonicalSignedControlEnvelope(input, options),
    CHECKPOINT_AUTHORITY_DELEGATION_OBJECT_TYPE_V1,
    validateCheckpointAuthorityDelegationPlainV1,
  ) as SignedCheckpointAuthorityDelegationEnvelopeV1;
}

type PayloadValidator = (value: unknown) => {
  readonly snapshot: unknown;
  readonly canonical: string;
};

function validateUnsignedEnvelopeSnapshot(
  value: unknown,
  objectType: string,
  payloadValidator: PayloadValidator,
): UnsignedControlEnvelopeV1 {
  assertUnsignedEnvelopePlain(value, objectType, payloadValidator);
  const snapshot = clonePlainData(value, `unsigned ${objectType} envelope`);
  assertUnsignedEnvelopePlain(snapshot, objectType, payloadValidator);
  assertAdministrativeAuthorityIssuerBinding(snapshot, objectType);
  return snapshot;
}

function validateSignedEnvelopeSnapshot(
  value: unknown,
  objectType: string,
  payloadValidator: PayloadValidator,
): SignedControlEnvelopeV1 {
  assertSignedEnvelopePlain(value, objectType, payloadValidator);
  const snapshot = clonePlainData(value, `signed ${objectType} envelope`);
  assertSignedEnvelopePlain(snapshot, objectType, payloadValidator);
  assertAdministrativeAuthorityIssuerBinding(snapshot, objectType);
  return snapshot;
}

/**
 * Bind the issuer only after the whole envelope has been cloned and validated
 * again. This prevents a stateful in-memory caller from presenting one
 * issuer/payload relationship during structural validation and another while
 * the authority relationship is checked.
 */
function assertAdministrativeAuthorityIssuerBinding(
  envelope: UnsignedControlEnvelopeV1 | SignedControlEnvelopeV1,
  objectType: string,
): void {
  if (objectType === CG_OWNERSHIP_TRANSITION_OBJECT_TYPE_V1) {
    const transition = envelope.payload as unknown as CgOwnershipTransitionV1;
    if (envelope.issuer !== transition.finalizedTransfer.newOwnerAddress) {
      fail(
        'admin-authority-branch',
        'ownership-transition issuer must equal finalizedTransfer.newOwnerAddress',
      );
    }
    return;
  }

  if (objectType === CG_ADMINISTRATIVE_DELEGATION_OBJECT_TYPE_V1) {
    const delegation = envelope.payload as unknown as CgAdministrativeDelegationV1;
    if (envelope.issuer !== delegation.ownerAddress) {
      fail(
        'admin-authority-branch',
        'administrative-delegation issuer must equal ownerAddress',
      );
    }
  }
}

function assertUnsignedEnvelopePlain(
  value: unknown,
  objectType: string,
  payloadValidator: PayloadValidator,
): asserts value is UnsignedControlEnvelopeV1 {
  try {
    assertUnsignedControlEnvelope(value as UnsignedControlEnvelopeV1);
  } catch (cause) {
    fail('admin-authority-schema', 'unsigned control envelope is invalid', cause);
  }
  const envelope = value as UnsignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, objectType);
  payloadValidator(envelope.payload);
}

function assertSignedEnvelopePlain(
  value: unknown,
  objectType: string,
  payloadValidator: PayloadValidator,
): asserts value is SignedControlEnvelopeV1 {
  try {
    assertSignedControlEnvelope(value as SignedControlEnvelopeV1);
  } catch (cause) {
    fail('admin-authority-schema', 'signed control envelope is invalid', cause);
  }
  const envelope = value as SignedControlEnvelopeV1;
  assertObjectType(envelope.objectType, objectType);
  payloadValidator(envelope.payload);
}

function computeTypedObjectDigest(
  value: unknown,
  objectType: string,
  payloadValidator: PayloadValidator,
): Digest32V1 {
  const snapshot = validateUnsignedEnvelopeSnapshot(value, objectType, payloadValidator);
  const digest = computeControlObjectDigestHex(snapshot);
  assertCanonicalDigest(digest, 'objectDigest');
  return digest;
}

function validateCgOwnershipTransitionSnapshotV1(value: unknown): {
  readonly snapshot: CgOwnershipTransitionV1;
  readonly canonical: string;
} {
  const bounded = validateCgOwnershipTransitionPlainV1(value);
  return validateCgOwnershipTransitionPlainV1(
    clonePlainData(bounded.snapshot, 'CG ownership transition'),
  );
}

function validateCgOwnershipTransitionPlainV1(value: unknown): {
  readonly snapshot: CgOwnershipTransitionV1;
  readonly canonical: string;
} {
  assertCgOwnershipTransitionStructureV1(value);
  return { snapshot: value, canonical: canonicalizePayload(value, 'CG ownership transition') };
}

function assertCgOwnershipTransitionStructureV1(
  value: unknown,
): asserts value is CgOwnershipTransitionV1 {
  if (!isPlainRecord(value)) fail('admin-authority-schema', 'ownership transition must be an object');
  closed(value, [
    'contextGraphId',
    'finalizedTransfer',
    'issuedAt',
    'mode',
    'networkId',
    'ownershipEpoch',
    'previousFinalizedTransfer',
  ], 'ownership transition');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  const ownershipEpoch = u64(value.ownershipEpoch, 'ownershipEpoch');
  if (ownershipEpoch === 0n) {
    fail('admin-authority-branch', 'ownershipEpoch is a one-based finalized transfer index');
  }
  if (value.previousFinalizedTransfer !== null) {
    assertFinalizedTransferPosition(value.previousFinalizedTransfer, 'previousFinalizedTransfer');
  }
  assertFinalizedOwnershipTransfer(value.finalizedTransfer);
  if ((ownershipEpoch === 1n) !== (value.previousFinalizedTransfer === null)) {
    fail(
      'admin-authority-branch',
      'only ownership epoch one may have a null previous finalized transfer',
    );
  }
  if (
    value.previousFinalizedTransfer !== null
    && compareTransferPositions(value.previousFinalizedTransfer, value.finalizedTransfer) >= 0
  ) {
    fail('admin-authority-order', 'previous finalized transfer must precede finalized transfer');
  }
  if (value.mode !== CG_OWNERSHIP_TRANSITION_MODE_V1) {
    fail('admin-authority-branch', 'ownership transition mode must be chain-rebaseline-v1');
  }
  timestamp(value.issuedAt, 'issuedAt');
}

function assertFinalizedTransferPosition(
  value: unknown,
  label: string,
): asserts value is FinalizedTransferPositionV1 {
  if (!isPlainRecord(value)) fail('admin-authority-schema', `${label} must be an object`);
  closed(value, [
    'blockHash',
    'blockNumber',
    'logIndex',
    'transactionHash',
    'transactionIndex',
  ], label);
  u64(value.blockNumber, `${label}.blockNumber`);
  digest(value.blockHash, `${label}.blockHash`);
  digest(value.transactionHash, `${label}.transactionHash`);
  u64(value.transactionIndex, `${label}.transactionIndex`);
  u64(value.logIndex, `${label}.logIndex`);
}

function assertFinalizedOwnershipTransfer(
  value: unknown,
): asserts value is FinalizedOwnershipTransferV1 {
  if (!isPlainRecord(value)) {
    fail('admin-authority-schema', 'finalizedTransfer must be an object');
  }
  closed(value, [
    'blockHash',
    'blockNumber',
    'chainId',
    'contractAddress',
    'logIndex',
    'newOwnerAddress',
    'previousOwnerAddress',
    'transactionHash',
    'transactionIndex',
  ], 'finalizedTransfer');
  scalar(() => assertCanonicalChainId(value.chainId));
  scalar(() => assertCanonicalEvmAddress(value.contractAddress, 'finalizedTransfer.contractAddress'));
  u64(value.blockNumber, 'finalizedTransfer.blockNumber');
  digest(value.blockHash, 'finalizedTransfer.blockHash');
  digest(value.transactionHash, 'finalizedTransfer.transactionHash');
  u64(value.transactionIndex, 'finalizedTransfer.transactionIndex');
  u64(value.logIndex, 'finalizedTransfer.logIndex');
  scalar(() => assertCanonicalEvmAddress(
    value.previousOwnerAddress,
    'finalizedTransfer.previousOwnerAddress',
  ));
  scalar(() => assertCanonicalEvmAddress(value.newOwnerAddress, 'finalizedTransfer.newOwnerAddress'));
}

function validateCgAdministrativeDelegationSnapshotV1(value: unknown): {
  readonly snapshot: CgAdministrativeDelegationV1;
  readonly canonical: string;
} {
  const bounded = validateCgAdministrativeDelegationPlainV1(value);
  return validateCgAdministrativeDelegationPlainV1(
    clonePlainData(bounded.snapshot, 'CG administrative delegation'),
  );
}

function validateCgAdministrativeDelegationPlainV1(value: unknown): {
  readonly snapshot: CgAdministrativeDelegationV1;
  readonly canonical: string;
} {
  assertCgAdministrativeDelegationStructureV1(value);
  return {
    snapshot: value,
    canonical: canonicalizePayload(value, 'CG administrative delegation'),
  };
}

function assertCgAdministrativeDelegationStructureV1(
  value: unknown,
): asserts value is CgAdministrativeDelegationV1 {
  if (!isPlainRecord(value)) {
    fail('admin-authority-schema', 'administrative delegation must be an object');
  }
  closed(value, [
    'adminEra',
    'contextGraphId',
    'delegateAddress',
    'effectiveAt',
    'expiresAt',
    'networkId',
    'ownerAddress',
    'ownershipTransitionDigest',
    'previousDelegationDigest',
    'roles',
    'source',
    'version',
  ], 'administrative delegation');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  optionalDigest(value.ownershipTransitionDigest, 'ownershipTransitionDigest');
  const adminEra = u64(value.adminEra, 'adminEra');
  const version = u64(value.version, 'version');
  optionalDigest(value.previousDelegationDigest, 'previousDelegationDigest');
  if (
    (value.previousDelegationDigest === null)
    !== (adminEra === 0n && version === 0n)
  ) {
    fail(
      'admin-authority-branch',
      'previousDelegationDigest must be null exactly for admin era/version zero',
    );
  }
  scalar(() => assertCanonicalEvmAddress(value.ownerAddress, 'ownerAddress'));
  scalar(() => assertCanonicalEvmAddress(value.delegateAddress, 'delegateAddress'));
  assertAdministrativeRoles(value.roles);
  assertAdministrativeSource(value.source, value.ownershipTransitionDigest);
  const effectiveAt = timestamp(value.effectiveAt, 'effectiveAt');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  if (effectiveAt >= expiresAt) {
    fail('admin-authority-order', 'effectiveAt must be earlier than expiresAt');
  }
}

function assertAdministrativeRoles(
  value: unknown,
): asserts value is CgAdministrativeDelegationRoleV1[] {
  assertDenseArray(value, 'roles', CG_ADMINISTRATIVE_DELEGATION_ROLES_V1.length);
  let previous: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const roleValue = value[index];
    if (typeof roleValue !== 'string' || !isAdministrativeRole(roleValue)) {
      fail('admin-authority-role', 'administrative role is not recognized by v1');
    }
    if (previous !== undefined && previous >= roleValue) {
      fail(
        previous === roleValue ? 'admin-authority-role' : 'admin-authority-order',
        'administrative roles must be strictly sorted and unique',
      );
    }
    previous = roleValue;
  }
}

function assertAdministrativeSource(
  value: unknown,
  ownershipTransitionDigest: unknown,
): asserts value is CgAdministrativeDelegationSourceV1 {
  if (!isPlainRecord(value)) {
    fail('admin-authority-schema', 'administrative source must be an object');
  }
  const kind = ownDataField(value, 'kind', 'administrative source');
  if (kind === 'finalized-chain-owner') {
    closed(value, [
      'blockHash',
      'blockNumber',
      'chainId',
      'contractAddress',
      'kind',
    ], 'finalized-chain-owner source');
    scalar(() => assertCanonicalChainId(value.chainId));
    scalar(() => assertCanonicalEvmAddress(value.contractAddress, 'source.contractAddress'));
    u64(value.blockNumber, 'source.blockNumber');
    digest(value.blockHash, 'source.blockHash');
    return;
  }
  if (kind === 'owner-signed-unregistered') {
    closed(value, ['kind', 'ownerAuthorityEra'], 'owner-signed-unregistered source');
    u64(value.ownerAuthorityEra, 'source.ownerAuthorityEra');
    if (ownershipTransitionDigest !== null) {
      fail(
        'admin-authority-branch',
        'owner-signed-unregistered source requires a null ownership transition',
      );
    }
    return;
  }
  fail('admin-authority-branch', 'administrative source kind is not supported by v1');
}

function validateCheckpointAuthorityDelegationSnapshotV1(value: unknown): {
  readonly snapshot: CheckpointAuthorityDelegationV1;
  readonly canonical: string;
} {
  const bounded = validateCheckpointAuthorityDelegationPlainV1(value);
  return validateCheckpointAuthorityDelegationPlainV1(
    clonePlainData(bounded.snapshot, 'checkpoint-authority delegation'),
  );
}

function validateCheckpointAuthorityDelegationPlainV1(value: unknown): {
  readonly snapshot: CheckpointAuthorityDelegationV1;
  readonly canonical: string;
} {
  assertCheckpointAuthorityDelegationStructureV1(value);
  return {
    snapshot: value,
    canonical: canonicalizePayload(value, 'checkpoint-authority delegation'),
  };
}

function assertCheckpointAuthorityDelegationStructureV1(
  value: unknown,
): asserts value is CheckpointAuthorityDelegationV1 {
  if (!isPlainRecord(value)) {
    fail('admin-authority-schema', 'checkpoint-authority delegation must be an object');
  }
  closed(value, [
    'activatedAt',
    'administrativeDelegationDigest',
    'authorityEpoch',
    'checkpointAuthorityAddress',
    'contextGraphId',
    'expiresAt',
    'networkId',
    'ownershipTransitionDigest',
    'predecessorCheckpointDigest',
    'predecessorCheckpointVersion',
    'previousDelegationDigest',
    'rebaselineTransitionDigest',
    'standbyCheckpointAuthorityAddress',
  ], 'checkpoint-authority delegation');
  scalar(() => assertNetworkIdV1(value.networkId));
  scalar(() => assertContextGraphIdV1(value.contextGraphId));
  optionalDigest(value.ownershipTransitionDigest, 'ownershipTransitionDigest');
  const authorityEpoch = u64(value.authorityEpoch, 'authorityEpoch');
  optionalDigest(value.previousDelegationDigest, 'previousDelegationDigest');
  optionalDigest(value.predecessorCheckpointDigest, 'predecessorCheckpointDigest');
  const predecessorVersion = value.predecessorCheckpointVersion === null
    ? null
    : u64(value.predecessorCheckpointVersion, 'predecessorCheckpointVersion');
  optionalDigest(value.rebaselineTransitionDigest, 'rebaselineTransitionDigest');
  const predecessorIsNull = value.predecessorCheckpointDigest === null;
  if (predecessorIsNull !== (predecessorVersion === null)) {
    fail(
      'admin-authority-branch',
      'predecessor checkpoint digest and version must be jointly null or non-null',
    );
  }
  assertCheckpointLineageBranch(
    value as unknown as CheckpointAuthorityDelegationV1,
    authorityEpoch,
    predecessorIsNull,
  );
  scalar(() => assertCanonicalEvmAddress(
    value.checkpointAuthorityAddress,
    'checkpointAuthorityAddress',
  ));
  if (value.standbyCheckpointAuthorityAddress !== null) {
    scalar(() => assertCanonicalEvmAddress(
      value.standbyCheckpointAuthorityAddress,
      'standbyCheckpointAuthorityAddress',
    ));
    if (value.standbyCheckpointAuthorityAddress === value.checkpointAuthorityAddress) {
      fail('admin-authority-branch', 'standby authority must differ from active authority');
    }
  }
  optionalDigest(
    value.administrativeDelegationDigest,
    'administrativeDelegationDigest',
  );
  const activatedAt = timestamp(value.activatedAt, 'activatedAt');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  if (activatedAt >= expiresAt) {
    fail('admin-authority-order', 'activatedAt must be earlier than expiresAt');
  }
}

function assertCheckpointLineageBranch(
  value: CheckpointAuthorityDelegationV1,
  authorityEpoch: bigint,
  predecessorIsNull: boolean,
): void {
  if (value.rebaselineTransitionDigest !== null) {
    if (
      value.ownershipTransitionDigest === null
      || value.rebaselineTransitionDigest !== value.ownershipTransitionDigest
      || !predecessorIsNull
      || value.previousDelegationDigest !== null
      || authorityEpoch !== 0n
    ) {
      fail(
        'admin-authority-branch',
        'rebaseline must bind its ownership transition and start a zero/null lineage',
      );
    }
    return;
  }

  if (predecessorIsNull) {
    if (
      value.ownershipTransitionDigest !== null
      || value.previousDelegationDigest !== null
      || authorityEpoch !== 0n
    ) {
      fail(
        'admin-authority-branch',
        'initial delegation must use the zero/null initial-owner lineage',
      );
    }
    return;
  }

  if (value.previousDelegationDigest === null || authorityEpoch === 0n) {
    fail(
      'admin-authority-branch',
      'ordinary rotation requires a predecessor delegation and nonzero authority epoch',
    );
  }
}

function compareTransferPositions(
  left: FinalizedTransferPositionV1,
  right: FinalizedTransferPositionV1,
): number {
  const leftParts = [left.blockNumber, left.transactionIndex, left.logIndex];
  const rightParts = [right.blockNumber, right.transactionIndex, right.logIndex];
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = u64(leftParts[index], `left transfer position ${index}`);
    const rightPart = u64(rightParts[index], `right transfer position ${index}`);
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parsePayload<T>(
  input: string | Uint8Array,
  options: StrictJsonParseOptions,
  label: string,
  validator: (value: unknown) => { readonly snapshot: T; readonly canonical: string },
): T {
  rejectOversizedInput(input, label);
  const value = parseCanonicalJson(input, {
    ...options,
    maxBytes: Math.min(
      options.maxBytes ?? MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1,
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1,
    ),
    maxDepth: Math.min(
      options.maxDepth ?? MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_DEPTH_V1,
      MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_DEPTH_V1,
    ),
  });
  return validator(value).snapshot;
}

function canonicalizePayload(value: object, label: string): string {
  try {
    return canonicalizeJson(value as unknown as CanonicalJsonValue, {
      maxBytes: MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1,
      maxDepth: MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_DEPTH_V1,
    });
  } catch (cause) {
    fail(
      'admin-authority-payload-too-large',
      `${label} exceeds the canonical payload cap`,
      cause,
    );
  }
}

function clonePlainData<T>(value: T, label: string): T {
  assertStablePlainDataShape(value, label, 0, new Set<object>());
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(
      'admin-authority-schema',
      `${label} must be stable structured-cloneable JSON data`,
      cause,
    );
  }
}

function assertStablePlainDataShape(
  value: unknown,
  label: string,
  depth: number,
  ancestors: Set<object>,
): void {
  if (depth > 64) fail('admin-authority-schema', `${label} exceeds the generic nesting cap`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('admin-authority-schema', `${label} contains a non-JSON number`);
    return;
  }
  if (typeof value !== 'object') {
    fail('admin-authority-schema', `${label} contains a non-JSON implementation value`);
  }
  if (ancestors.has(value)) fail('admin-authority-schema', `${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail('admin-authority-schema', `${label} contains a non-ordinary array`);
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) {
        fail('admin-authority-schema', `${label} contains a sparse or custom array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('admin-authority-schema', `${label} contains an array accessor`);
        }
        assertStablePlainDataShape(descriptor.value, `${label}[${index}]`, depth + 1, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('admin-authority-schema', `${label} contains a non-plain object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        fail('admin-authority-schema', `${label} contains a symbol property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail('admin-authority-schema', `${label} contains an object accessor`);
      }
      assertStablePlainDataShape(descriptor.value, `${label}.${key}`, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function ownDataField(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail('admin-authority-schema', `${label}.${key} must be an enumerable data field`);
  }
  return descriptor.value;
}

function assertDenseArray(
  value: unknown,
  label: string,
  maxLength: number,
): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('admin-authority-schema', `${label} must be an ordinary array`);
  }
  if (value.length > maxLength) {
    fail('admin-authority-role', `${label} exceeds the closed role registry`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) {
    fail('admin-authority-schema', `${label} must be dense and contain no custom properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('admin-authority-schema', `${label} must contain ordinary enumerable values`);
    }
  }
}

function isAdministrativeRole(value: string): value is CgAdministrativeDelegationRoleV1 {
  return CG_ADMINISTRATIVE_DELEGATION_ROLES_V1.includes(
    value as CgAdministrativeDelegationRoleV1,
  );
}

function u64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('admin-authority-scalar', `${label} must be canonical DecimalU64V1`, cause);
  }
}

function timestamp(value: unknown, label: string): bigint {
  scalar(() => assertCanonicalTimestampMs(value, label));
  return u64(value, label);
}

function optionalDigest(value: unknown, label: string): void {
  if (value !== null) digest(value, label);
}

function digest(value: unknown, label: string): void {
  scalar(() => assertCanonicalDigest(value, label));
}

function scalar(operation: () => void): void {
  try {
    operation();
  } catch (cause) {
    fail('admin-authority-scalar', 'administrative authority scalar is not canonical', cause);
  }
}

function closed(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  try {
    assertExactKeys(record, keys, label);
  } catch (cause) {
    fail('admin-authority-schema', `${label} has an invalid field set`, cause);
  }
}

function assertObjectType(actual: unknown, expected: string): void {
  if (actual !== expected) {
    fail('admin-authority-type', `objectType must be exactly ${expected}`);
  }
}

function rejectOversizedInput(input: string | Uint8Array, label: string): void {
  if (
    typeof input === 'string'
    && input.length > MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1
  ) {
    fail(
      'admin-authority-payload-too-large',
      `${label} exceeds ${MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1} bytes`,
    );
  }
  const byteLength = typeof input === 'string'
    ? new TextEncoder().encode(input).byteLength
    : input.byteLength;
  if (byteLength > MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1) {
    fail(
      'admin-authority-payload-too-large',
      `${label} exceeds ${MAX_ADMINISTRATIVE_AUTHORITY_PAYLOAD_BYTES_V1} bytes`,
    );
  }
}

function fail(
  code: AdministrativeAuthorityCodecErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AdministrativeAuthorityCodecError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
