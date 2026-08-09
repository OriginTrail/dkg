import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { type NetworkIdV1 } from './sync-wire-identifiers.js';
import { hasOwnDataProperty, snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  type AgentProfileHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import {
  assertAgentRootV1,
  assertCanonicalRfc3339SecondsV1,
  assertSystemRecordAddressV1,
  assertSystemRecordNetworkV1,
  assertSystemRecordPeerBindingV1,
  digest,
  digestArray,
  digestSystemRecordBytesV1,
  snapshotSystemRecordDataRecord,
  u64,
  type CanonicalRfc3339SecondsV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-agent-profile-primitives-v1-internal.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';

const REQUEST_RECORD_KIND = SYSTEM_RECORD_KIND_V1;

export interface AgentProfileAuthorityTransitionV1 {
  readonly objectType: 'authority-transition';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly mode: 'co-signed' | 'expired-prior';
  readonly networkId: NetworkIdV1;
  readonly peerId: string;
  readonly peerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly priorAuthoritySequence: DecimalU64V1;
  readonly nextAuthoritySequence: DecimalU64V1;
  readonly priorHeadDigest: Digest32V1;
  readonly priorEvmIssuer: EvmAddressV1;
  readonly nextEvmIssuer: EvmAddressV1;
  readonly nextRoot: string;
  readonly issuedAt: CanonicalRfc3339SecondsV1;
  readonly priorValidUntil?: CanonicalRfc3339SecondsV1;
}

export interface AgentProfileForkResolutionV1 {
  readonly objectType: 'fork-resolution';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly peerId: string;
  readonly peerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly evmIssuer: EvmAddressV1;
  readonly authoritySequence: DecimalU64V1;
  readonly forkedVersion: DecimalU64V1;
  readonly resolutionVersion: DecimalU64V1;
  readonly forkBaseHeadDigest?: Digest32V1;
  readonly evidenceHeadDigests: readonly Digest32V1[];
  readonly issuedAt: CanonicalRfc3339SecondsV1;
}


export type SystemRecordSignatureRoleV1 = 'peer' | 'prior-evm' | 'next-evm' | 'current-evm';
export type SystemRecordSignatureSuiteV1 =
  | 'ed25519-v1'
  | 'eip191-personal-sign-digest-v1'
  | 'eip1271-current-finalized-v1';

export interface SystemRecordNoSignatureEvidenceV1 {
  readonly kind: 'none';
}

export interface SystemRecordEip1271EvidenceV1 {
  readonly kind: 'eip1271-current-finalized';
  readonly chainId: ChainIdV1;
  readonly contractAddress: EvmAddressV1;
  readonly finalizedBlockNumber: DecimalU64V1;
  readonly finalizedBlockHash: Digest32V1;
}

export interface SystemRecordSignatureEntryV1 {
  readonly role: SystemRecordSignatureRoleV1;
  readonly suite: SystemRecordSignatureSuiteV1;
  readonly signer: string;
  readonly evidence: SystemRecordNoSignatureEvidenceV1 | SystemRecordEip1271EvidenceV1;
  readonly signature: string;
}

export interface SignedSystemRecordEnvelopeV1<T> {
  readonly object: T;
  readonly objectDigest: Digest32V1;
  readonly signatures: readonly SystemRecordSignatureEntryV1[];
}

export type SignedAgentProfileHeadEnvelopeV1 =
  SignedSystemRecordEnvelopeV1<AgentProfileHeadObjectV1>;
export type SignedAgentProfileAuthorityTransitionEnvelopeV1 =
  SignedSystemRecordEnvelopeV1<AgentProfileAuthorityTransitionV1>;
export type SignedAgentProfileForkResolutionEnvelopeV1 =
  SignedSystemRecordEnvelopeV1<AgentProfileForkResolutionV1>;



export function assertAgentProfileAuthorityTransitionV1(
  value: unknown,
): asserts value is AgentProfileAuthorityTransitionV1 {
  validateAuthorityTransition(value);
}

export function canonicalizeAgentProfileAuthorityTransitionV1(
  value: AgentProfileAuthorityTransitionV1,
): Uint8Array {
  const validated = validateAuthorityTransition(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['authority-transition'],
  });
}

export function parseCanonicalAgentProfileAuthorityTransitionV1(
  input: string | Uint8Array,
): AgentProfileAuthorityTransitionV1 {
  return validateAuthorityTransition(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['authority-transition'],
      maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
    }),
  );
}

export function computeAgentProfileAuthorityTransitionDigestV1(
  value: AgentProfileAuthorityTransitionV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.authorityTransition,
    canonicalizeAgentProfileAuthorityTransitionV1(value),
  );
}

export function validateAuthorityTransition(value: unknown): AgentProfileAuthorityTransitionV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'authority transition');
  const mode = probe.mode;
  if (mode !== 'co-signed' && mode !== 'expired-prior') {
    fail('system-record-schema', 'authority transition mode is invalid');
  }
  const expected = [
    'objectType',
    'kind',
    'mode',
    'networkId',
    'peerId',
    'peerPublicKey',
    'priorAuthoritySequence',
    'nextAuthoritySequence',
    'priorHeadDigest',
    'priorEvmIssuer',
    'nextEvmIssuer',
    'nextRoot',
    'issuedAt',
    ...(mode === 'expired-prior' ? ['priorValidUntil'] : []),
  ] as const;
  const transition = snapshotExactDataRecord(probe, expected, 'authority transition');
  if (transition.objectType !== 'authority-transition' || transition.kind !== REQUEST_RECORD_KIND) {
    fail('system-record-schema', 'authority transition tag is invalid');
  }
  assertSystemRecordNetworkV1(transition.networkId);
  assertSystemRecordPeerBindingV1(transition.peerId, transition.peerPublicKey);
  const prior = u64(transition.priorAuthoritySequence, 'priorAuthoritySequence');
  const next = u64(transition.nextAuthoritySequence, 'nextAuthoritySequence');
  if (next !== prior + 1n || next > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    fail('system-record-history', 'authority transition must increment within the V1 bound');
  }
  digest(transition.priorHeadDigest, 'priorHeadDigest');
  assertSystemRecordAddressV1(transition.priorEvmIssuer, 'priorEvmIssuer');
  assertSystemRecordAddressV1(transition.nextEvmIssuer, 'nextEvmIssuer');
  assertAgentRootV1(transition.nextRoot, transition.nextEvmIssuer as string);
  if (transition.priorEvmIssuer === transition.nextEvmIssuer) {
    fail('system-record-history', 'authority transition must rotate to a new wallet root');
  }
  assertCanonicalRfc3339SecondsV1(transition.issuedAt, 'issuedAt');
  if (mode === 'expired-prior') {
    assertCanonicalRfc3339SecondsV1(transition.priorValidUntil, 'priorValidUntil');
  }
  return Object.freeze({
    ...transition,
  }) as unknown as AgentProfileAuthorityTransitionV1;
}

export function assertAgentProfileForkResolutionV1(
  value: unknown,
): asserts value is AgentProfileForkResolutionV1 {
  validateForkResolution(value);
}

export function canonicalizeAgentProfileForkResolutionV1(
  value: AgentProfileForkResolutionV1,
): Uint8Array {
  const validated = validateForkResolution(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['fork-resolution'],
  });
}

export function parseCanonicalAgentProfileForkResolutionV1(
  input: string | Uint8Array,
): AgentProfileForkResolutionV1 {
  return validateForkResolution(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['fork-resolution'],
      maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
    }),
  );
}

export function computeAgentProfileForkResolutionDigestV1(
  value: AgentProfileForkResolutionV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.forkResolution,
    canonicalizeAgentProfileForkResolutionV1(value),
  );
}

export function validateForkResolution(value: unknown): AgentProfileForkResolutionV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'fork resolution');
  const expected = [
    'objectType',
    'kind',
    'networkId',
    'peerId',
    'peerPublicKey',
    'evmIssuer',
    'authoritySequence',
    'forkedVersion',
    'resolutionVersion',
    ...(hasOwnDataProperty(probe, 'forkBaseHeadDigest') ? ['forkBaseHeadDigest'] : []),
    'evidenceHeadDigests',
    'issuedAt',
  ] as const;
  const resolution = snapshotExactDataRecord(probe, expected, 'fork resolution');
  if (resolution.objectType !== 'fork-resolution' || resolution.kind !== REQUEST_RECORD_KIND) {
    fail('system-record-schema', 'fork resolution tag is invalid');
  }
  assertSystemRecordNetworkV1(resolution.networkId);
  assertSystemRecordPeerBindingV1(resolution.peerId, resolution.peerPublicKey);
  assertSystemRecordAddressV1(resolution.evmIssuer, 'evmIssuer');
  const sequence = u64(resolution.authoritySequence, 'authoritySequence');
  const forked = u64(resolution.forkedVersion, 'forkedVersion');
  const version = u64(resolution.resolutionVersion, 'resolutionVersion');
  if (sequence > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX || version <= forked) {
    fail('system-record-history', 'fork resolution sequence/version is invalid');
  }
  if ((forked === 0n) === hasOwnDataProperty(resolution, 'forkBaseHeadDigest')) {
    fail('system-record-history', 'fork base is omitted only for a version-zero fork');
  }
  if (hasOwnDataProperty(resolution, 'forkBaseHeadDigest'))
    digest(resolution.forkBaseHeadDigest, 'forkBaseHeadDigest');
  const evidenceHeadDigests = digestArray(
    resolution.evidenceHeadDigests,
    'evidenceHeadDigests',
    2,
    SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  );
  assertCanonicalRfc3339SecondsV1(resolution.issuedAt, 'issuedAt');
  return Object.freeze({
    ...resolution,
    evidenceHeadDigests,
  }) as unknown as AgentProfileForkResolutionV1;
}
