import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';

import { assertAssertionCoordinateV1, type AssertionCoordinateV1 } from './author-catalog-codec.js';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  type CanonicalGraphScopedAuthorSealV1,
} from './canonical-graph-scoped-author-seal.js';
import {
  canonicalizeJson,
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { workspaceAgentEncryptionKeyId } from './crypto/workspace-encryption.js';
import { parseDeterministicKnowledgeAssetUal } from './ka-content-scope.js';
import {
  classifyAgentProfileOwnedSubjectV1,
  matchAgentProfileRootAddressV1,
} from './agent-profile-schema-model-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  hasOwnDataProperty,
  snapshotDataArray,
  snapshotDataRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
  SystemRecordObjectErrorV1,
  type SystemRecordObjectErrorCodeV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_CONFLICT_ENTRIES,
  SYSTEM_RECORD_MAX_JSON_DEPTH,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';

const UTF8 = new TextEncoder();
const RFC3339_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const REQUEST_RECORD_KIND = SYSTEM_RECORD_KIND_V1;

export type CanonicalRfc3339SecondsV1 = string & {
  readonly __rfc3339SecondsV1: true;
};
export {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  decodeUnpaddedBase64UrlV1,
  digestSystemRecordBytesV1,
  SystemRecordObjectErrorV1,
};
export type { SystemRecordObjectErrorCodeV1, SystemRecordPeerPublicKeyV1 };
export {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  AGENT_PROFILE_SCHEMA_TERMS_V1,
  classifyAgentProfileOwnedSubjectV1,
  deriveAgentProfileOwnedSubjectV1,
  isAllowedAgentProfilePredicateV1,
} from './agent-profile-schema-model-v1.js';
export type {
  AgentProfileExactLinkedSubjectKindV1,
  AgentProfileIndexedSubjectKindV1,
  AgentProfileLinkedSubjectKindV1,
  AgentProfileOwnedSubjectKindV1,
} from './agent-profile-schema-model-v1.js';

export interface AgentProfileHeadCommonV1 {
  readonly objectType: 'agent-profile-head';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly state: 'active' | 'tombstone';
  readonly networkId: NetworkIdV1;
  readonly peerId: string;
  readonly peerPublicKey: SystemRecordPeerPublicKeyV1;
  readonly authoritySequence: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly previousHeadDigest?: Digest32V1;
  readonly acceptedTransitionDigest?: Digest32V1;
  readonly forkResolutionDigest?: Digest32V1;
  readonly evmIssuer: EvmAddressV1;
  readonly rootSubject: string;
  readonly projectionSchemaDigest: Digest32V1;
  readonly issuedAt: CanonicalRfc3339SecondsV1;
  readonly ownedSubjectTableDigest: Digest32V1;
  readonly ownedSubjectCount: DecimalU64V1;
  readonly projectionBytes: DecimalU64V1;
  readonly projectionQuads: DecimalU64V1;
}

export interface AgentProfileActiveHeadObjectV1 extends AgentProfileHeadCommonV1 {
  readonly state: 'active';
  readonly validUntil: CanonicalRfc3339SecondsV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly graphScopedAuthorSeal: CanonicalGraphScopedAuthorSealV1;
  readonly contentDigest: Digest32V1;
  readonly bundleDigest: Digest32V1;
}

export interface AgentProfileTombstoneHeadObjectV1 extends AgentProfileHeadCommonV1 {
  readonly state: 'tombstone';
  readonly previousHeadDigest: Digest32V1;
}

export type AgentProfileHeadObjectV1 =
  | AgentProfileActiveHeadObjectV1
  | AgentProfileTombstoneHeadObjectV1;

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

export interface AgentProfileForkConflictEntryV1 {
  readonly type: 'fork';
  readonly authoritySequence: DecimalU64V1;
  readonly version: DecimalU64V1;
  readonly objectDigests: readonly Digest32V1[];
}

export interface AgentProfileTransitionConflictEntryV1 {
  readonly type: 'transition';
  readonly priorAuthoritySequence: DecimalU64V1;
  readonly nextAuthoritySequence: DecimalU64V1;
  readonly objectDigests: readonly Digest32V1[];
}

export interface AgentProfileConflictEvidenceV1 {
  readonly objectType: 'conflict-evidence';
  readonly kind: typeof SYSTEM_RECORD_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly peerId: string;
  readonly entries: readonly (
    | AgentProfileForkConflictEntryV1
    | AgentProfileTransitionConflictEntryV1
  )[];
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

export type OwnedSubjectTableObjectV1 = readonly string[];

export function assertCanonicalRfc3339SecondsV1(
  value: unknown,
  label = 'timestamp',
): asserts value is CanonicalRfc3339SecondsV1 {
  if (typeof value !== 'string')
    fail('system-record-scalar', `${label} must be an RFC3339 UTC second`);
  const match = RFC3339_SECONDS.exec(value);
  if (match === null || match[1] === '0000' || match[6] === '60') {
    fail('system-record-scalar', `${label} must be YYYY-MM-DDTHH:mm:ssZ without leap seconds`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail('system-record-scalar', `${label} must be a calendar-valid RFC3339 UTC second`);
  }
}

export function parseCanonicalRfc3339SecondsV1(value: CanonicalRfc3339SecondsV1): number {
  assertCanonicalRfc3339SecondsV1(value);
  return Date.parse(value);
}

export function assertSystemRecordPeerBindingV1(
  peerId: unknown,
  peerPublicKey: unknown,
): asserts peerPublicKey is SystemRecordPeerPublicKeyV1 {
  if (
    typeof peerId !== 'string' ||
    peerId.length > SYSTEM_RECORD_MAX_PEER_ID_BYTES ||
    UTF8.encode(peerId).byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES
  ) {
    fail('system-record-scalar', 'peerId is outside its byte bound');
  }
  try {
    if (peerIdFromString(peerId).toString() !== peerId) throw new Error('noncanonical peer ID');
    const keyBytes = decodeUnpaddedBase64UrlV1(
      peerPublicKey,
      SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
      'peerPublicKey',
    );
    const derived = peerIdFromPublicKey(publicKeyFromRaw(keyBytes)).toString();
    if (derived !== peerId) fail('system-record-binding', 'peerPublicKey does not derive peerId');
  } catch (cause) {
    if (cause instanceof SystemRecordObjectErrorV1) throw cause;
    fail('system-record-binding', 'peerId/public-key binding is invalid', cause);
  }
}

export function assertAgentRootV1(value: unknown, issuer?: string): asserts value is string {
  if (typeof value !== 'string' || matchAgentProfileRootAddressV1(value) === null) {
    fail('system-record-scalar', 'agent root must be a canonical did:dkg:agent address');
  }
  const rootAddress = matchAgentProfileRootAddressV1(value)!;
  try {
    assertCanonicalEvmAddress(rootAddress, 'agent root address');
  } catch (cause) {
    fail('system-record-scalar', 'agent root address is invalid', cause);
  }
  if (issuer !== undefined && value !== `did:dkg:agent:${issuer}`) {
    fail('system-record-binding', 'agent root does not match its EVM issuer');
  }
}

export function digestSystemRecordJsonV1(
  domain: string,
  value: CanonicalJsonValue,
  maxBytes: number,
): Digest32V1 {
  return digestSystemRecordBytesV1(domain, canonicalizeJsonBytes(value, { maxBytes }));
}

export interface SystemRecordRootCollisionEvidenceV1 {
  readonly networkId: NetworkIdV1;
  readonly root: string;
  readonly incumbentRecordKey: readonly [NetworkIdV1, string];
  readonly contenderStableKey: Digest32V1;
  readonly contenderHeadDigest: Digest32V1;
}

export function canonicalizeSystemRecordRootCollisionEvidenceV1(
  value: SystemRecordRootCollisionEvidenceV1,
): Uint8Array {
  const evidence = snapshotExactDataRecord(
    value,
    ['networkId', 'root', 'incumbentRecordKey', 'contenderStableKey', 'contenderHeadDigest'],
    'root-collision evidence',
  );
  const incumbentRecordKey = snapshotRootCollisionRecordKey(evidence.incumbentRecordKey);
  assertNetwork(evidence.networkId);
  assertAgentRootV1(evidence.root);
  if (incumbentRecordKey[0] !== evidence.networkId) {
    fail('system-record-binding', 'root-collision incumbent record key must bind networkId');
  }
  assertCanonicalSystemRecordPeerIdV1(incumbentRecordKey[1]);
  digest(evidence.contenderStableKey, 'contenderStableKey');
  digest(evidence.contenderHeadDigest, 'contenderHeadDigest');
  return canonicalizeJsonBytes(
    [
      evidence.networkId,
      evidence.root,
      incumbentRecordKey,
      evidence.contenderStableKey,
      evidence.contenderHeadDigest,
    ],
    { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'] },
  );
}

function snapshotRootCollisionRecordKey(value: unknown): readonly [NetworkIdV1, string] {
  try {
    return snapshotDataArray(value, 'root-collision incumbent record key', {
      minLength: 2,
      maxLength: 2,
    }) as readonly [NetworkIdV1, string];
  } catch (cause) {
    fail(
      'system-record-schema',
      'root-collision incumbent record key must be a closed two-item tuple',
      cause,
    );
  }
}

export function computeSystemRecordRootCollisionEvidenceDigestV1(
  value: SystemRecordRootCollisionEvidenceV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.rootCollisionEvidence,
    canonicalizeSystemRecordRootCollisionEvidenceV1(value),
  );
}

export const EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 = digestSystemRecordJsonV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
  [],
  SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
);

const HEAD_COMMON_KEYS = [
  'objectType',
  'kind',
  'state',
  'networkId',
  'peerId',
  'peerPublicKey',
  'authoritySequence',
  'version',
  'evmIssuer',
  'rootSubject',
  'projectionSchemaDigest',
  'issuedAt',
  'ownedSubjectTableDigest',
  'ownedSubjectCount',
  'projectionBytes',
  'projectionQuads',
] as const;
const HEAD_OPTIONAL_DIGEST_KEYS = [
  'previousHeadDigest',
  'acceptedTransitionDigest',
  'forkResolutionDigest',
] as const;
const ACTIVE_HEAD_KEYS = [
  'validUntil',
  'assertionCoordinate',
  'graphScopedAuthorSeal',
  'contentDigest',
  'bundleDigest',
] as const;

export function assertAgentProfileHeadObjectV1(
  value: unknown,
): asserts value is AgentProfileHeadObjectV1 {
  validateAgentProfileHeadObjectV1(value);
}

export function canonicalizeAgentProfileHeadObjectV1(value: AgentProfileHeadObjectV1): Uint8Array {
  const validated = validateAgentProfileHeadObjectV1(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'],
  });
}

export function parseCanonicalAgentProfileHeadObjectV1(
  input: string | Uint8Array,
): AgentProfileHeadObjectV1 {
  const parsed = parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'],
    maxDepth: SYSTEM_RECORD_MAX_JSON_DEPTH,
  });
  return validateAgentProfileHeadObjectV1(parsed);
}

export function computeAgentProfileHeadObjectDigestV1(value: AgentProfileHeadObjectV1): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.agentProfileHead,
    canonicalizeAgentProfileHeadObjectV1(value),
  );
}

export function validateAgentProfileHeadObjectV1(value: unknown): AgentProfileHeadObjectV1 {
  const probe = snapshotSystemRecordDataRecord(value, 'agent profile head');
  const state = probe.state;
  if (state !== 'active' && state !== 'tombstone') {
    fail('system-record-schema', 'agent profile head state must be active or tombstone');
  }
  const optional = HEAD_OPTIONAL_DIGEST_KEYS.filter((key) => hasOwnDataProperty(probe, key));
  const expected =
    state === 'active'
      ? [...HEAD_COMMON_KEYS, ...optional, ...ACTIVE_HEAD_KEYS]
      : [...HEAD_COMMON_KEYS, ...optional];
  const head = snapshotExactDataRecord(probe, expected, 'agent profile head');
  if (head.objectType !== 'agent-profile-head' || head.kind !== REQUEST_RECORD_KIND) {
    fail('system-record-schema', 'agent profile head tag is invalid');
  }
  assertNetwork(head.networkId);
  assertSystemRecordPeerBindingV1(head.peerId, head.peerPublicKey);
  const authoritySequence = u64(head.authoritySequence, 'authoritySequence');
  const version = u64(head.version, 'version');
  if (authoritySequence > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    fail('system-record-limit', 'authoritySequence exceeds the V1 root-claim bound');
  }
  for (const key of optional) digest(head[key], key);
  address(head.evmIssuer, 'evmIssuer');
  assertAgentRootV1(head.rootSubject, head.evmIssuer as string);
  digest(head.projectionSchemaDigest, 'projectionSchemaDigest');
  assertCanonicalRfc3339SecondsV1(head.issuedAt, 'issuedAt');
  digest(head.ownedSubjectTableDigest, 'ownedSubjectTableDigest');
  const ownedSubjectCount = u64(head.ownedSubjectCount, 'ownedSubjectCount');
  const projectionBytes = u64(head.projectionBytes, 'projectionBytes');
  const projectionQuads = u64(head.projectionQuads, 'projectionQuads');
  if (ownedSubjectCount > BigInt(SYSTEM_RECORD_MAX_OWNED_SUBJECTS)) {
    fail('system-record-limit', 'ownedSubjectCount exceeds the V1 subject bound');
  }
  if (
    projectionBytes > BigInt(SYSTEM_RECORD_MAX_PROJECTION_BYTES) ||
    projectionQuads > BigInt(SYSTEM_RECORD_MAX_PROJECTION_QUADS)
  ) {
    fail('system-record-limit', 'profile projection exceeds the V1 bound');
  }

  const previous = hasOwnDataProperty(head, 'previousHeadDigest');
  const transition = hasOwnDataProperty(head, 'acceptedTransitionDigest');
  const resolution = hasOwnDataProperty(head, 'forkResolutionDigest');
  if (authoritySequence === 0n && transition) {
    fail('system-record-history', 'sequence zero must omit acceptedTransitionDigest');
  }
  if (authoritySequence > 0n && !transition) {
    fail('system-record-history', 'nonzero authority sequence requires acceptedTransitionDigest');
  }
  if (authoritySequence === 0n && version === 0n && (previous || transition || resolution)) {
    fail('system-record-history', 'ordinary initial head must omit all history digests');
  }
  if (version === 0n && previous) {
    fail('system-record-history', 'version-zero head must omit previousHeadDigest');
  }
  if (!resolution && version > 0n && !previous) {
    fail('system-record-history', 'ordinary noninitial head requires previousHeadDigest');
  }

  let graphScopedAuthorSeal: Readonly<CanonicalGraphScopedAuthorSealV1> | undefined;
  if (state === 'active') {
    assertCanonicalRfc3339SecondsV1(head.validUntil, 'validUntil');
    if (Date.parse(head.validUntil as string) <= Date.parse(head.issuedAt as string)) {
      fail('system-record-history', 'validUntil must be later than issuedAt');
    }
    try {
      assertAssertionCoordinateV1(head.assertionCoordinate);
      const sealSnapshot = snapshotDataRecord(
        head.graphScopedAuthorSeal,
        'graph-scoped author seal',
      );
      assertCanonicalGraphScopedAuthorSealV1(sealSnapshot);
      graphScopedAuthorSeal = sealSnapshot;
    } catch (cause) {
      fail('system-record-binding', 'active head coordinate/seal is invalid', cause);
    }
    digest(head.contentDigest, 'contentDigest');
    digest(head.bundleDigest, 'bundleDigest');
    if (ownedSubjectCount === 0n || projectionBytes === 0n || projectionQuads === 0n) {
      fail('system-record-binding', 'active head projection counts must be nonzero');
    }
    const seal = graphScopedAuthorSeal;
    const ual = parseDeterministicKnowledgeAssetUal(seal.kaUal);
    if (ual.chainId !== head.networkId) {
      fail('system-record-binding', 'graph-scoped seal UAL network must equal the head networkId');
    }
    if (seal.assertedAtChainId !== numericChainIdForNetworkV1(head.networkId)) {
      fail(
        'system-record-binding',
        'graph-scoped seal asserted chain must equal the head network chain',
      );
    }
    if (seal.authorAddress !== head.evmIssuer) {
      fail('system-record-binding', 'graph-scoped seal author must equal evmIssuer');
    }
    if (seal.assertionMerkleRoot !== head.contentDigest) {
      fail(
        'system-record-binding',
        'contentDigest must equal the graph-scoped assertion Merkle root',
      );
    }
    if (seal.publicTripleCount !== head.projectionQuads) {
      fail(
        'system-record-binding',
        'projectionQuads must equal the graph-scoped public triple count',
      );
    }
    if (seal.privateTripleCount !== '0' || seal.privateMerkleRoot !== null) {
      fail(
        'system-record-binding',
        'agents system records require a public-only graph-scoped seal',
      );
    }
    if (head.ownedSubjectTableDigest === EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1) {
      fail('system-record-binding', 'active head must commit a nonempty owned-subject table');
    }
  } else {
    if (!previous || version === 0n) {
      fail('system-record-history', 'tombstone must name an accepted active predecessor');
    }
    if (resolution) {
      fail('system-record-history', 'V1 has no direct terminal fork-resolution tombstone');
    }
    if (ownedSubjectCount !== 0n || projectionBytes !== 0n || projectionQuads !== 0n) {
      fail('system-record-binding', 'tombstone projection accounting must be zero');
    }
    if (head.ownedSubjectTableDigest !== EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1) {
      fail('system-record-binding', 'tombstone must commit the canonical empty subject table');
    }
  }
  return Object.freeze(
    state === 'active' ? { ...head, graphScopedAuthorSeal } : { ...head },
  ) as unknown as AgentProfileHeadObjectV1;
}

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
  assertNetwork(transition.networkId);
  assertSystemRecordPeerBindingV1(transition.peerId, transition.peerPublicKey);
  const prior = u64(transition.priorAuthoritySequence, 'priorAuthoritySequence');
  const next = u64(transition.nextAuthoritySequence, 'nextAuthoritySequence');
  if (next !== prior + 1n || next > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    fail('system-record-history', 'authority transition must increment within the V1 bound');
  }
  digest(transition.priorHeadDigest, 'priorHeadDigest');
  address(transition.priorEvmIssuer, 'priorEvmIssuer');
  address(transition.nextEvmIssuer, 'nextEvmIssuer');
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
  assertNetwork(resolution.networkId);
  assertSystemRecordPeerBindingV1(resolution.peerId, resolution.peerPublicKey);
  address(resolution.evmIssuer, 'evmIssuer');
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

export function assertAgentProfileConflictEvidenceV1(
  value: unknown,
): asserts value is AgentProfileConflictEvidenceV1 {
  validateConflictEvidence(value);
}

export function canonicalizeAgentProfileConflictEvidenceV1(
  value: AgentProfileConflictEvidenceV1,
): Uint8Array {
  const validated = validateConflictEvidence(value);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'],
  });
}

export function parseCanonicalAgentProfileConflictEvidenceV1(
  input: string | Uint8Array,
): AgentProfileConflictEvidenceV1 {
  return validateConflictEvidence(
    parseCanonicalJson(input, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'],
      maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
    }),
  );
}

export function computeAgentProfileConflictEvidenceDigestV1(
  value: AgentProfileConflictEvidenceV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence,
    canonicalizeAgentProfileConflictEvidenceV1(value),
  );
}

export function validateConflictEvidence(value: unknown): AgentProfileConflictEvidenceV1 {
  const evidence = snapshotExactDataRecord(
    value,
    ['objectType', 'kind', 'networkId', 'peerId', 'entries'],
    'conflict evidence',
  );
  if (evidence.objectType !== 'conflict-evidence' || evidence.kind !== REQUEST_RECORD_KIND) {
    fail('system-record-schema', 'conflict evidence tag is invalid');
  }
  assertNetwork(evidence.networkId);
  assertCanonicalSystemRecordPeerIdV1(evidence.peerId);
  let conflictEntries: readonly unknown[];
  try {
    conflictEntries = snapshotDataArray(evidence.entries, 'conflict evidence entries', {
      minLength: 1,
      maxLength: SYSTEM_RECORD_MAX_CONFLICT_ENTRIES,
    });
  } catch (cause) {
    fail('system-record-limit', 'conflict evidence must contain 1-8 closed entries', cause);
  }
  let totalDigests = 0;
  let priorSortKey = '';
  const entries = conflictEntries.map((candidate, index) => {
    const probe = snapshotSystemRecordDataRecord(candidate, `conflict evidence entry ${index}`);
    let entry: AgentProfileForkConflictEntryV1 | AgentProfileTransitionConflictEntryV1;
    let sortKey: string;
    if (probe.type === 'fork') {
      const row = snapshotExactDataRecord(
        probe,
        ['type', 'authoritySequence', 'version', 'objectDigests'],
        `fork conflict entry ${index}`,
      );
      const sequence = u64(row.authoritySequence, 'authoritySequence');
      if (sequence > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
        fail('system-record-history', 'fork conflict authority sequence exceeds the V1 limit');
      }
      const version = u64(row.version, 'version');
      const objectDigests = digestArray(
        row.objectDigests,
        'objectDigests',
        2,
        SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
      );
      sortKey = `0:${sequence.toString().padStart(20, '0')}:${version.toString().padStart(20, '0')}`;
      entry = Object.freeze({
        ...row,
        objectDigests,
      }) as unknown as AgentProfileForkConflictEntryV1;
    } else if (probe.type === 'transition') {
      const row = snapshotExactDataRecord(
        probe,
        ['type', 'priorAuthoritySequence', 'nextAuthoritySequence', 'objectDigests'],
        `transition conflict entry ${index}`,
      );
      const prior = u64(row.priorAuthoritySequence, 'priorAuthoritySequence');
      const next = u64(row.nextAuthoritySequence, 'nextAuthoritySequence');
      if (next !== prior + 1n || next > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
        fail(
          'system-record-history',
          'transition conflict tuple must increment within the V1 sequence limit',
        );
      }
      const objectDigests = digestArray(
        row.objectDigests,
        'objectDigests',
        2,
        SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
      );
      sortKey = `1:${prior.toString().padStart(20, '0')}:${next.toString().padStart(20, '0')}`;
      entry = Object.freeze({
        ...row,
        objectDigests,
      }) as unknown as AgentProfileTransitionConflictEntryV1;
    } else {
      fail('system-record-schema', 'conflict entry type is invalid');
    }
    if (index > 0 && priorSortKey >= sortKey) {
      fail('system-record-order', 'conflict evidence entries must use canonical type/tuple order');
    }
    priorSortKey = sortKey;
    totalDigests += entry.objectDigests.length;
    return entry;
  });
  if (totalDigests > SYSTEM_RECORD_MAX_CONFLICT_DIGESTS) {
    fail('system-record-limit', 'conflict evidence exceeds 16 total object digests');
  }
  return Object.freeze({
    ...evidence,
    entries: Object.freeze(entries),
  }) as unknown as AgentProfileConflictEvidenceV1;
}

export function assertDerivedAgentEncryptionSubjectV1(
  rootSubject: string,
  subject: string,
  publicKeyBytes: Uint8Array,
): void {
  assertAgentRootV1(rootSubject);
  let ownedPublicKey: Uint8Array;
  try {
    ownedPublicKey = copyBoundedSystemRecordBytesV1(publicKeyBytes, 32, 'x25519 public key');
  } catch (cause) {
    fail('system-record-binding', 'x25519 public key must contain exactly 32 bytes', cause);
  }
  if (ownedPublicKey.byteLength !== 32) {
    fail('system-record-binding', 'x25519 public key must contain exactly 32 bytes');
  }
  const address = matchAgentProfileRootAddressV1(rootSubject)!;
  const expected = workspaceAgentEncryptionKeyId(address, ownedPublicKey);
  if (subject !== expected) {
    fail(
      'system-record-binding',
      'x25519 owned subject is not derived from its root and public key',
    );
  }
}

export function assertOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: unknown,
): asserts value is OwnedSubjectTableObjectV1 {
  validateOwnedSubjectTableObjectV1(rootSubject, value);
}

function validateOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: unknown,
): OwnedSubjectTableObjectV1 {
  assertAgentRootV1(rootSubject);
  let subjects: readonly unknown[];
  try {
    subjects = snapshotDataArray(value, 'owned-subject table', {
      maxLength: SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
    });
  } catch (cause) {
    fail('system-record-limit', 'owned-subject table exceeds its closed-array bound', cause);
  }
  let previous: Uint8Array | undefined;
  let encodedLowerBound = 2;
  for (const candidate of subjects) {
    if (
      typeof candidate !== 'string' ||
      candidate.length > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'] ||
      classifyAgentProfileOwnedSubjectV1(rootSubject, candidate) === null
    ) {
      fail('system-record-binding', 'owned-subject table contains an invalid subject');
    }
    const bytes = UTF8.encode(candidate);
    encodedLowerBound += bytes.byteLength + (previous === undefined ? 2 : 3);
    if (encodedLowerBound > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table']) {
      fail('system-record-limit', 'owned-subject table exceeds its encoded byte cap');
    }
    if (previous !== undefined && compareBytes(previous, bytes) >= 0) {
      fail('system-record-order', 'owned-subject table must be UTF-8 sorted and duplicate-free');
    }
    previous = bytes;
  }
  canonicalizeJson(subjects as readonly string[], {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
  });
  return subjects as OwnedSubjectTableObjectV1;
}

export function canonicalizeOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: OwnedSubjectTableObjectV1,
): Uint8Array {
  const validated = validateOwnedSubjectTableObjectV1(rootSubject, value);
  return canonicalizeJsonBytes(validated, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
  });
}

export function parseCanonicalOwnedSubjectTableObjectV1(
  rootSubject: string,
  input: string | Uint8Array,
): OwnedSubjectTableObjectV1 {
  const parsed = parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'],
    maxDepth: SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  });
  return validateOwnedSubjectTableObjectV1(rootSubject, parsed);
}

export function computeOwnedSubjectTableDigestV1(
  rootSubject: string,
  value: OwnedSubjectTableObjectV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
    canonicalizeOwnedSubjectTableObjectV1(rootSubject, value),
  );
}

export function snapshotSystemRecordDataRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  try {
    return snapshotDataRecord(value, label, { rejectNullValues: true });
  } catch (cause) {
    fail(
      'system-record-schema',
      cause instanceof Error ? cause.message : `${label} is invalid`,
      cause,
    );
  }
}

export function numericChainIdForNetworkV1(networkId: NetworkIdV1): ChainIdV1 {
  const separator = networkId.lastIndexOf(':');
  const chainId = separator <= 0 ? '' : networkId.slice(separator + 1);
  try {
    assertCanonicalChainId(chainId, 'network chainId');
  } catch (cause) {
    fail('system-record-binding', 'record requires a numeric chain-bound networkId', cause);
  }
  return chainId as ChainIdV1;
}

function assertNetwork(value: unknown): asserts value is NetworkIdV1 {
  try {
    assertNetworkIdV1(value);
  } catch (cause) {
    fail('system-record-scalar', 'networkId is invalid', cause);
  }
}

function address(value: unknown, label: string): asserts value is EvmAddressV1 {
  try {
    assertCanonicalEvmAddress(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

export function digest(value: unknown, label: string): asserts value is Digest32V1 {
  try {
    assertCanonicalDigest(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

export function u64(value: unknown, label: string): bigint {
  try {
    return parseCanonicalDecimalU64(value, label);
  } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

function digestArray(
  value: unknown,
  label: string,
  min: number,
  max: number,
): readonly Digest32V1[] {
  let snapshot: readonly unknown[];
  try {
    snapshot = snapshotDataArray(value, label, {
      minLength: min,
      maxLength: max,
    });
  } catch (cause) {
    fail('system-record-limit', `${label} must contain ${min}-${max} closed digests`, cause);
  }
  for (let index = 0; index < snapshot.length; index += 1) {
    digest(snapshot[index], `${label}[${index}]`);
    if (index > 0 && (snapshot[index - 1] as string) >= (snapshot[index] as string)) {
      fail('system-record-order', `${label} must be sorted and duplicate-free`);
    }
  }
  return snapshot as readonly Digest32V1[];
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}
