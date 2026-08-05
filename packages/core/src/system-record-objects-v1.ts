import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { verifyAsync as verifyEd25519 } from '@noble/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  assertAssertionCoordinateV1,
  type AssertionCoordinateV1,
} from './author-catalog-codec.js';
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
import { keccak256 } from './crypto/keccak.js';
import { workspaceAgentEncryptionKeyId } from './crypto/workspace-encryption.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
  SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
  SYSTEM_RECORD_EIP191_MAX_S,
  SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_ACTIVATION_METADATA_BYTES,
  SYSTEM_RECORD_MAX_ACTIVATION_RECORDS,
  SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES,
  SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES,
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES,
  SYSTEM_RECORD_MAX_CONFLICT_SIDECARS,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_CONFLICT_ENTRIES,
  SYSTEM_RECORD_MAX_EIP1271_SIGNATURE_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PEER_ID_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
  SYSTEM_RECORD_MAX_RESOLVED_FORK_TUPLES,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
  SYSTEM_RECORD_MAX_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
  SYSTEM_RECORD_MAX_SIDECAR_BYTES,
  SYSTEM_RECORD_MAX_SIDECAR_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_SIGNATURE_DOMAINS_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';

const UTF8 = new TextEncoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RFC3339_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const AGENT_ROOT = /^did:dkg:agent:(0x[0-9a-f]{40})$/;
const REQUEST_RECORD_KIND = SYSTEM_RECORD_KIND_V1;

export type CanonicalRfc3339SecondsV1 = string & { readonly __rfc3339SecondsV1: true };
export type SystemRecordPeerPublicKeyV1 = string & { readonly __peerPublicKeyV1: true };

export type SystemRecordObjectErrorCodeV1 =
  | 'system-record-schema'
  | 'system-record-scalar'
  | 'system-record-binding'
  | 'system-record-history'
  | 'system-record-signature'
  | 'system-record-order'
  | 'system-record-limit'
  | 'system-record-closure';

export class SystemRecordObjectErrorV1 extends Error {
  constructor(
    readonly code: SystemRecordObjectErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'SystemRecordObjectErrorV1';
  }
}

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

export type SignedAgentProfileHeadEnvelopeV1 = SignedSystemRecordEnvelopeV1<AgentProfileHeadObjectV1>;
export type SignedAgentProfileAuthorityTransitionEnvelopeV1 =
  SignedSystemRecordEnvelopeV1<AgentProfileAuthorityTransitionV1>;
export type SignedAgentProfileForkResolutionEnvelopeV1 =
  SignedSystemRecordEnvelopeV1<AgentProfileForkResolutionV1>;

export type OwnedSubjectTableObjectV1 = readonly string[];

export function assertCanonicalRfc3339SecondsV1(
  value: unknown,
  label = 'timestamp',
): asserts value is CanonicalRfc3339SecondsV1 {
  if (typeof value !== 'string') fail('system-record-scalar', `${label} must be an RFC3339 UTC second`);
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

export function decodeUnpaddedBase64UrlV1(
  value: unknown,
  expectedBytes: number,
  label: string,
): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.includes('=') || !BASE64URL.test(value)) {
    fail('system-record-scalar', `${label} must be unpadded base64url`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (bytes.byteLength !== expectedBytes || Buffer.from(bytes).toString('base64url') !== value) {
    fail('system-record-scalar', `${label} must canonically encode exactly ${expectedBytes} bytes`);
  }
  return bytes;
}

export function assertSystemRecordPeerBindingV1(
  peerId: unknown,
  peerPublicKey: unknown,
): asserts peerPublicKey is SystemRecordPeerPublicKeyV1 {
  if (typeof peerId !== 'string' || UTF8.encode(peerId).byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
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
  if (typeof value !== 'string' || !AGENT_ROOT.test(value)) {
    fail('system-record-scalar', 'agent root must be a canonical did:dkg:agent address');
  }
  const rootAddress = AGENT_ROOT.exec(value)![1];
  try {
    assertCanonicalEvmAddress(rootAddress, 'agent root address');
  } catch (cause) {
    fail('system-record-scalar', 'agent root address is invalid', cause);
  }
  if (issuer !== undefined && value !== `did:dkg:agent:${issuer}`) {
    fail('system-record-binding', 'agent root does not match its EVM issuer');
  }
}

export function digestSystemRecordBytesV1(domain: string, bytes: Uint8Array): Digest32V1 {
  const input = new Uint8Array(UTF8.encode(domain).byteLength + bytes.byteLength);
  input.set(UTF8.encode(domain));
  input.set(bytes, UTF8.encode(domain).byteLength);
  return (`0x${Buffer.from(sha256(input)).toString('hex')}`) as Digest32V1;
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
  assertNetwork(value.networkId);
  assertAgentRootV1(value.root);
  if (!Array.isArray(value.incumbentRecordKey) || value.incumbentRecordKey.length !== 2
    || value.incumbentRecordKey[0] !== value.networkId) {
    fail('system-record-binding', 'root-collision incumbent record key must bind networkId');
  }
  assertCanonicalSystemRecordPeerIdV1(value.incumbentRecordKey[1]);
  digest(value.contenderStableKey, 'contenderStableKey');
  digest(value.contenderHeadDigest, 'contenderHeadDigest');
  return canonicalizeJsonBytes([
    value.networkId,
    value.root,
    [value.incumbentRecordKey[0], value.incumbentRecordKey[1]],
    value.contenderStableKey,
    value.contenderHeadDigest,
  ], { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'] });
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
  'objectType', 'kind', 'state', 'networkId', 'peerId', 'peerPublicKey',
  'authoritySequence', 'version', 'evmIssuer', 'rootSubject',
  'projectionSchemaDigest', 'issuedAt', 'ownedSubjectTableDigest',
  'ownedSubjectCount', 'projectionBytes', 'projectionQuads',
] as const;
const HEAD_OPTIONAL_DIGEST_KEYS = [
  'previousHeadDigest', 'acceptedTransitionDigest', 'forkResolutionDigest',
] as const;
const ACTIVE_HEAD_KEYS = [
  'validUntil', 'assertionCoordinate', 'graphScopedAuthorSeal', 'contentDigest',
  'bundleDigest',
] as const;

export function assertAgentProfileHeadObjectV1(
  value: unknown,
): asserts value is AgentProfileHeadObjectV1 {
  validateAgentProfileHeadObjectV1(value);
}

export function canonicalizeAgentProfileHeadObjectV1(
  value: AgentProfileHeadObjectV1,
): Uint8Array {
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

export function computeAgentProfileHeadObjectDigestV1(
  value: AgentProfileHeadObjectV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.agentProfileHead,
    canonicalizeAgentProfileHeadObjectV1(value),
  );
}

function validateAgentProfileHeadObjectV1(value: unknown): AgentProfileHeadObjectV1 {
  const probe = snapshotRecord(value, 'agent profile head');
  const state = probe.state;
  if (state !== 'active' && state !== 'tombstone') {
    fail('system-record-schema', 'agent profile head state must be active or tombstone');
  }
  const optional = HEAD_OPTIONAL_DIGEST_KEYS.filter((key) => hasOwn(probe, key));
  const expected = state === 'active'
    ? [...HEAD_COMMON_KEYS, ...optional, ...ACTIVE_HEAD_KEYS]
    : [...HEAD_COMMON_KEYS, ...optional];
  const head = snapshotExactDataRecord(value, expected, 'agent profile head');
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
  if (projectionBytes > BigInt(SYSTEM_RECORD_MAX_PROJECTION_BYTES)
    || projectionQuads > BigInt(SYSTEM_RECORD_MAX_PROJECTION_QUADS)) {
    fail('system-record-limit', 'profile projection exceeds the V1 bound');
  }

  const previous = hasOwn(head, 'previousHeadDigest');
  const transition = hasOwn(head, 'acceptedTransitionDigest');
  const resolution = hasOwn(head, 'forkResolutionDigest');
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

  if (state === 'active') {
    assertCanonicalRfc3339SecondsV1(head.validUntil, 'validUntil');
    if (Date.parse(head.validUntil as string) <= Date.parse(head.issuedAt as string)) {
      fail('system-record-history', 'validUntil must be later than issuedAt');
    }
    try {
      assertAssertionCoordinateV1(head.assertionCoordinate);
      assertCanonicalGraphScopedAuthorSealV1(head.graphScopedAuthorSeal);
    } catch (cause) {
      fail('system-record-binding', 'active head coordinate/seal is invalid', cause);
    }
    digest(head.contentDigest, 'contentDigest');
    digest(head.bundleDigest, 'bundleDigest');
    if (ownedSubjectCount === 0n || projectionBytes === 0n || projectionQuads === 0n) {
      fail('system-record-binding', 'active head projection counts must be nonzero');
    }
    const seal = head.graphScopedAuthorSeal as CanonicalGraphScopedAuthorSealV1;
    if (seal.authorAddress !== head.evmIssuer) {
      fail('system-record-binding', 'graph-scoped seal author must equal evmIssuer');
    }
    if (seal.assertionMerkleRoot !== head.contentDigest) {
      fail('system-record-binding', 'contentDigest must equal the graph-scoped assertion Merkle root');
    }
    if (seal.publicTripleCount !== head.projectionQuads) {
      fail('system-record-binding', 'projectionQuads must equal the graph-scoped public triple count');
    }
    if (seal.privateTripleCount !== '0' || seal.privateMerkleRoot !== null) {
      fail('system-record-binding', 'agents system records require a public-only graph-scoped seal');
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
  return Object.freeze({ ...head }) as unknown as AgentProfileHeadObjectV1;
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
  return validateAuthorityTransition(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['authority-transition'], maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  }));
}

export function computeAgentProfileAuthorityTransitionDigestV1(
  value: AgentProfileAuthorityTransitionV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.authorityTransition,
    canonicalizeAgentProfileAuthorityTransitionV1(value),
  );
}

function validateAuthorityTransition(value: unknown): AgentProfileAuthorityTransitionV1 {
  const probe = snapshotRecord(value, 'authority transition');
  const mode = probe.mode;
  if (mode !== 'co-signed' && mode !== 'expired-prior') {
    fail('system-record-schema', 'authority transition mode is invalid');
  }
  const expected = [
    'objectType', 'kind', 'mode', 'networkId', 'peerId', 'peerPublicKey',
    'priorAuthoritySequence', 'nextAuthoritySequence', 'priorHeadDigest',
    'priorEvmIssuer', 'nextEvmIssuer', 'nextRoot', 'issuedAt',
    ...(mode === 'expired-prior' ? ['priorValidUntil'] : []),
  ] as const;
  const transition = snapshotExactDataRecord(value, expected, 'authority transition');
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
  return Object.freeze({ ...transition }) as unknown as AgentProfileAuthorityTransitionV1;
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
  return validateForkResolution(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['fork-resolution'], maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  }));
}

export function computeAgentProfileForkResolutionDigestV1(
  value: AgentProfileForkResolutionV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.forkResolution,
    canonicalizeAgentProfileForkResolutionV1(value),
  );
}

function validateForkResolution(value: unknown): AgentProfileForkResolutionV1 {
  const probe = snapshotRecord(value, 'fork resolution');
  const expected = [
    'objectType', 'kind', 'networkId', 'peerId', 'peerPublicKey', 'evmIssuer',
    'authoritySequence', 'forkedVersion', 'resolutionVersion',
    ...(hasOwn(probe, 'forkBaseHeadDigest') ? ['forkBaseHeadDigest'] : []),
    'evidenceHeadDigests', 'issuedAt',
  ] as const;
  const resolution = snapshotExactDataRecord(value, expected, 'fork resolution');
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
  if ((forked === 0n) === hasOwn(resolution, 'forkBaseHeadDigest')) {
    fail('system-record-history', 'fork base is omitted only for a version-zero fork');
  }
  if (hasOwn(resolution, 'forkBaseHeadDigest')) digest(resolution.forkBaseHeadDigest, 'forkBaseHeadDigest');
  digestArray(resolution.evidenceHeadDigests, 'evidenceHeadDigests', 2, SYSTEM_RECORD_MAX_CONFLICT_DIGESTS);
  assertCanonicalRfc3339SecondsV1(resolution.issuedAt, 'issuedAt');
  return Object.freeze({ ...resolution }) as unknown as AgentProfileForkResolutionV1;
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
  return validateConflictEvidence(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'], maxDepth: SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  }));
}

export function computeAgentProfileConflictEvidenceDigestV1(
  value: AgentProfileConflictEvidenceV1,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence,
    canonicalizeAgentProfileConflictEvidenceV1(value),
  );
}

function validateConflictEvidence(value: unknown): AgentProfileConflictEvidenceV1 {
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
  if (!Array.isArray(evidence.entries)
    || evidence.entries.length < 1
    || evidence.entries.length > SYSTEM_RECORD_MAX_CONFLICT_ENTRIES) {
    fail('system-record-limit', 'conflict evidence must contain 1-8 entries');
  }
  let totalDigests = 0;
  let priorSortKey = '';
  const entries = evidence.entries.map((candidate, index) => {
    const probe = snapshotRecord(candidate, `conflict evidence entry ${index}`);
    let entry: AgentProfileForkConflictEntryV1 | AgentProfileTransitionConflictEntryV1;
    let sortKey: string;
    if (probe.type === 'fork') {
      const row = snapshotExactDataRecord(
        candidate,
        ['type', 'authoritySequence', 'version', 'objectDigests'],
        `fork conflict entry ${index}`,
      );
      const sequence = u64(row.authoritySequence, 'authoritySequence');
      const version = u64(row.version, 'version');
      digestArray(row.objectDigests, 'objectDigests', 2, SYSTEM_RECORD_MAX_CONFLICT_DIGESTS);
      sortKey = `0:${sequence.toString().padStart(20, '0')}:${version.toString().padStart(20, '0')}`;
      entry = Object.freeze({ ...row }) as unknown as AgentProfileForkConflictEntryV1;
    } else if (probe.type === 'transition') {
      const row = snapshotExactDataRecord(
        candidate,
        ['type', 'priorAuthoritySequence', 'nextAuthoritySequence', 'objectDigests'],
        `transition conflict entry ${index}`,
      );
      const prior = u64(row.priorAuthoritySequence, 'priorAuthoritySequence');
      const next = u64(row.nextAuthoritySequence, 'nextAuthoritySequence');
      if (next !== prior + 1n) fail('system-record-history', 'transition conflict tuple must increment by one');
      digestArray(row.objectDigests, 'objectDigests', 2, SYSTEM_RECORD_MAX_CONFLICT_DIGESTS);
      sortKey = `1:${prior.toString().padStart(20, '0')}:${next.toString().padStart(20, '0')}`;
      entry = Object.freeze({ ...row }) as unknown as AgentProfileTransitionConflictEntryV1;
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
  return Object.freeze({ ...evidence, entries: Object.freeze(entries) }) as unknown as AgentProfileConflictEvidenceV1;
}

export type AgentProfileOwnedSubjectKindV1 =
  | 'root'
  | 'capability'
  | 'offering'
  | 'registration'
  | 'hosting'
  | 'x25519';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

export const AGENT_PROFILE_LINK_PREDICATES_V1 = Object.freeze({
  capability: `${ERC8004}capabilities`,
  offering: `${SKILL}offersSkill`,
  registration: `${PROV}wasGeneratedBy`,
  hosting: `${SKILL}hostingProfile`,
} as const);

const AGENT_PROFILE_PREDICATES_V1: Readonly<Record<AgentProfileOwnedSubjectKindV1, ReadonlySet<string>>> = {
  root: new Set([
    RDF_TYPE, `${SCHEMA}name`, `${SCHEMA}description`, `${DKG}peerId`, `${DKG}nodeRole`,
    `${DKG}publicKey`, `${DKG}relayAddress`, `${DKG}agentAddress`, `${DKG}multiaddr`,
    `${DKG}lastSeen`, `${DKG}publicEncryptionKey`, `${DKG}encryptionKeyAlgorithm`,
    `${DKG}encryptionKeyProof`, `${SKILL}framework`,
    ...Object.values(AGENT_PROFILE_LINK_PREDICATES_V1),
  ]),
  capability: new Set([RDF_TYPE, `${SCHEMA}name`]),
  offering: new Set([
    RDF_TYPE, `${SKILL}skill`, `${SKILL}pricePerCall`, `${SKILL}currency`,
    `${SKILL}successRate`, `${SKILL}pricing`,
  ]),
  registration: new Set([RDF_TYPE, `${PROV}atTime`]),
  hosting: new Set([RDF_TYPE, `${SKILL}contextGraphsServed`, `${SKILL}paranetsServed`]),
  x25519: new Set([`${DKG}revokedAt`, `${DKG}revokedBy`, `${DKG}encryptionKeyRevocationProof`]),
};

export function classifyAgentProfileOwnedSubjectV1(
  rootSubject: string,
  subject: string,
): AgentProfileOwnedSubjectKindV1 | null {
  if (!AGENT_ROOT.test(rootSubject)) return null;
  if (subject === rootSubject) return 'root';
  const wellKnown = `${rootSubject}/.well-known/genid/`;
  if (subject.startsWith(wellKnown)) {
    const suffix = subject.slice(wellKnown.length);
    if (/^cap[1-9][0-9]*$/.test(suffix)) return 'capability';
    if (/^offering[1-9][0-9]*$/.test(suffix)) return 'offering';
    if (suffix === 'registration') return 'registration';
    if (suffix === 'hosting') return 'hosting';
    return null;
  }
  const encryptionPrefix = `${rootSubject}#x25519-`;
  return subject.startsWith(encryptionPrefix)
    && /^[0-9a-f]{32}$/.test(subject.slice(encryptionPrefix.length))
    ? 'x25519'
    : null;
}

export function isAllowedAgentProfilePredicateV1(
  kind: AgentProfileOwnedSubjectKindV1,
  predicate: string,
): boolean {
  return AGENT_PROFILE_PREDICATES_V1[kind].has(predicate);
}

export function assertDerivedAgentEncryptionSubjectV1(
  rootSubject: string,
  subject: string,
  publicKeyBytes: Uint8Array,
): void {
  assertAgentRootV1(rootSubject);
  if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.byteLength !== 32) {
    fail('system-record-binding', 'x25519 public key must contain exactly 32 bytes');
  }
  const address = AGENT_ROOT.exec(rootSubject)![1];
  const expected = workspaceAgentEncryptionKeyId(address, publicKeyBytes);
  if (subject !== expected) {
    fail('system-record-binding', 'x25519 owned subject is not derived from its root and public key');
  }
}

export function assertOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: unknown,
): asserts value is OwnedSubjectTableObjectV1 {
  assertAgentRootV1(rootSubject);
  if (!Array.isArray(value) || value.length > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
    fail('system-record-limit', 'owned-subject table exceeds 2,048 subjects');
  }
  let previous: Uint8Array | undefined;
  for (const candidate of value) {
    if (typeof candidate !== 'string'
      || classifyAgentProfileOwnedSubjectV1(rootSubject, candidate) === null) {
      fail('system-record-binding', 'owned-subject table contains an invalid subject');
    }
    const bytes = UTF8.encode(candidate);
    if (previous !== undefined && compareBytes(previous, bytes) >= 0) {
      fail('system-record-order', 'owned-subject table must be UTF-8 sorted and duplicate-free');
    }
    previous = bytes;
  }
  canonicalizeJson(value, { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'] });
}

export function canonicalizeOwnedSubjectTableObjectV1(
  rootSubject: string,
  value: OwnedSubjectTableObjectV1,
): Uint8Array {
  assertOwnedSubjectTableObjectV1(rootSubject, value);
  return canonicalizeJsonBytes(value, { maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'] });
}

export function parseCanonicalOwnedSubjectTableObjectV1(
  rootSubject: string,
  input: string | Uint8Array,
): OwnedSubjectTableObjectV1 {
  const parsed = parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table'], maxDepth: SYSTEM_RECORD_MAX_ARRAY_JSON_DEPTH,
  });
  assertOwnedSubjectTableObjectV1(rootSubject, parsed);
  return Object.freeze([...(parsed as readonly string[])]);
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

const SIGNATURE_ROLE_ORDER: Readonly<Record<SystemRecordSignatureRoleV1, number>> = {
  peer: 0,
  'prior-evm': 1,
  'next-evm': 2,
  'current-evm': 3,
};

export function assertSignedAgentProfileHeadEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileHeadEnvelopeV1 {
  validateSignedEnvelope(value, 'head');
}

export function assertSignedAgentProfileAuthorityTransitionEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileAuthorityTransitionEnvelopeV1 {
  validateSignedEnvelope(value, 'transition');
}

export function assertSignedAgentProfileForkResolutionEnvelopeV1(
  value: unknown,
): asserts value is SignedAgentProfileForkResolutionEnvelopeV1 {
  validateSignedEnvelope(value, 'fork');
}

export function canonicalizeSignedSystemRecordEnvelopeV1<T>(
  value: SignedSystemRecordEnvelopeV1<T>,
): Uint8Array {
  const kind = classifyEnvelopeObject(value.object);
  const validated = validateSignedEnvelope(value, kind);
  return canonicalizeJsonBytes(validated as unknown as CanonicalJsonValue, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[objectKindForEnvelope(kind)],
  });
}

export function computeSignedSystemRecordEnvelopeDigestV1<T>(
  value: SignedSystemRecordEnvelopeV1<T>,
): Digest32V1 {
  return digestSystemRecordBytesV1(
    SYSTEM_RECORD_DIGEST_DOMAINS_V1.signedEnvelope,
    canonicalizeSignedSystemRecordEnvelopeV1(value),
  );
}

export function parseCanonicalSignedAgentProfileHeadEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileHeadEnvelopeV1 {
  return validateSignedEnvelope(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['agent-profile-head'], maxDepth: SYSTEM_RECORD_MAX_SIGNED_HEAD_JSON_DEPTH,
  }), 'head') as SignedAgentProfileHeadEnvelopeV1;
}

export function parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileAuthorityTransitionEnvelopeV1 {
  return validateSignedEnvelope(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['authority-transition'], maxDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  }), 'transition') as SignedAgentProfileAuthorityTransitionEnvelopeV1;
}

export function parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(
  input: string | Uint8Array,
): SignedAgentProfileForkResolutionEnvelopeV1 {
  return validateSignedEnvelope(parseCanonicalJson(input, {
    maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1['fork-resolution'], maxDepth: SYSTEM_RECORD_MAX_SIGNED_CONTROL_JSON_DEPTH,
  }), 'fork') as SignedAgentProfileForkResolutionEnvelopeV1;
}

function validateSignedEnvelope(
  value: unknown,
  kind: 'head' | 'transition' | 'fork',
): SignedSystemRecordEnvelopeV1<unknown> {
  const envelope = snapshotExactDataRecord(
    value,
    ['object', 'objectDigest', 'signatures'],
    'signed system-record envelope',
  );
  const object = kind === 'head'
    ? validateAgentProfileHeadObjectV1(envelope.object)
    : kind === 'transition'
      ? validateAuthorityTransition(envelope.object)
      : validateForkResolution(envelope.object);
  const expectedDigest = kind === 'head'
    ? computeAgentProfileHeadObjectDigestV1(object as AgentProfileHeadObjectV1)
    : kind === 'transition'
      ? computeAgentProfileAuthorityTransitionDigestV1(object as AgentProfileAuthorityTransitionV1)
      : computeAgentProfileForkResolutionDigestV1(object as AgentProfileForkResolutionV1);
  digest(envelope.objectDigest, 'objectDigest');
  if (envelope.objectDigest !== expectedDigest) {
    fail('system-record-binding', 'signed envelope objectDigest does not match the object');
  }
  const requiredRoles: readonly SystemRecordSignatureRoleV1[] = kind === 'transition'
    ? (object as AgentProfileAuthorityTransitionV1).mode === 'co-signed'
      ? ['peer', 'prior-evm', 'next-evm']
      : ['peer', 'next-evm']
    : ['peer', 'current-evm'];
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== requiredRoles.length) {
    fail('system-record-signature', 'signed envelope has the wrong signature cardinality');
  }
  const signatures = envelope.signatures.map((entry, index) =>
    validateSignatureEntry(entry, requiredRoles[index], object));
  return Object.freeze({ object, objectDigest: envelope.objectDigest, signatures: Object.freeze(signatures) });
}

function validateSignatureEntry(
  value: unknown,
  requiredRole: SystemRecordSignatureRoleV1,
  object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1,
): SystemRecordSignatureEntryV1 {
  const entry = snapshotExactDataRecord(
    value,
    ['role', 'suite', 'signer', 'evidence', 'signature'],
    `signature entry ${requiredRole}`,
  );
  if (entry.role !== requiredRole || SIGNATURE_ROLE_ORDER[requiredRole] === undefined) {
    fail('system-record-signature', 'signature roles are missing, extra, duplicated, or reordered');
  }
  const isPeer = requiredRole === 'peer';
  if (isPeer) {
    if (entry.suite !== 'ed25519-v1' || entry.signer !== object.peerId) {
      fail('system-record-signature', 'peer signature suite/signer is invalid');
    }
    exactNoneEvidence(entry.evidence);
    decodeUnpaddedBase64UrlV1(
      entry.signature,
      SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
      'Ed25519 signature',
    );
  } else {
    const issuer = issuerForRole(object, requiredRole);
    if (entry.signer !== issuer) {
      fail('system-record-signature', `${requiredRole} signer does not match the object authority`);
    }
    if (entry.suite === 'eip191-personal-sign-digest-v1') {
      exactNoneEvidence(entry.evidence);
      assertCanonicalEip191SignatureV1(entry.signature);
    } else if (entry.suite === 'eip1271-current-finalized-v1') {
      validateEip1271Evidence(entry.evidence, issuer);
      try {
        assertCanonicalHexBytes(
          entry.signature,
          'EIP-1271 signature',
          1,
          SYSTEM_RECORD_MAX_EIP1271_SIGNATURE_BYTES,
        );
      } catch (cause) {
        fail('system-record-signature', 'EIP-1271 signature bytes are invalid', cause);
      }
    } else {
      fail('system-record-signature', 'EVM signature suite is invalid');
    }
  }
  return Object.freeze({ ...entry }) as unknown as SystemRecordSignatureEntryV1;
}

export function assertCanonicalEip191SignatureV1(value: unknown): asserts value is string {
  try {
    assertCanonicalHexBytes(
      value,
      'EIP-191 signature',
      SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
      SYSTEM_RECORD_EIP191_SIGNATURE_BYTES,
    );
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 signature bytes are invalid', cause);
  }
  const bytes = hexToBytes(value as string);
  const s = bytesToBigInt(bytes.subarray(32, 64));
  if (s === 0n || s > SYSTEM_RECORD_EIP191_MAX_S) {
    fail('system-record-signature', 'EIP-191 signature must use canonical low-s form');
  }
  try {
    secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact');
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 compact signature is not canonical', cause);
  }
  if (bytes[64] !== 27 && bytes[64] !== 28) {
    fail('system-record-signature', 'EIP-191 recovery byte must be 27 or 28');
  }
}

export function buildSystemRecordSignatureMessageV1(
  object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1,
  objectDigest: Digest32V1,
  role: SystemRecordSignatureRoleV1,
): Uint8Array {
  digest(objectDigest, 'objectDigest');
  const recordKey: CanonicalJsonValue = [object.networkId, object.peerId];
  let tuple: CanonicalJsonValue;
  if (object.objectType === 'agent-profile-head') {
    if (role !== 'peer' && role !== 'current-evm') fail('system-record-signature', 'head role is invalid');
    tuple = [
      'agent-profile-head', objectDigest, object.networkId, recordKey,
      object.authoritySequence, object.version,
      ...(role === 'peer' ? [] : ['current-evm', object.evmIssuer]),
    ];
  } else if (object.objectType === 'authority-transition') {
    if (role !== 'peer' && role !== 'prior-evm' && role !== 'next-evm') {
      fail('system-record-signature', 'transition role is invalid');
    }
    tuple = [
      'authority-transition', objectDigest, object.networkId, recordKey,
      object.priorAuthoritySequence, object.nextAuthoritySequence, object.priorHeadDigest,
      role,
      ...(role === 'peer' ? [] : [issuerForRole(object, role)]),
    ];
  } else {
    if (role !== 'peer' && role !== 'current-evm') fail('system-record-signature', 'resolution role is invalid');
    tuple = [
      'fork-resolution', objectDigest, object.networkId, recordKey,
      object.authoritySequence, object.forkedVersion, object.resolutionVersion,
      role,
      ...(role === 'peer' ? [] : [object.evmIssuer]),
    ];
  }
  const domain = role === 'peer'
    ? SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.peer
    : SYSTEM_RECORD_SIGNATURE_DOMAINS_V1.evm;
  return concatBytes(UTF8.encode(domain), canonicalizeJsonBytes(tuple));
}

export interface VerifySystemRecordEnvelopeOptionsV1 {
  readonly verifyEip1271?: (
    entry: SystemRecordSignatureEntryV1,
    personalMessageHash: Uint8Array,
  ) => boolean | Promise<boolean>;
}

/** Cryptographically verify a structurally valid envelope without opening a materializer capability. */
export async function verifySignedSystemRecordEnvelopeV1<T extends
  AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1>(
  envelope: SignedSystemRecordEnvelopeV1<T>,
  options: VerifySystemRecordEnvelopeOptionsV1 = {},
): Promise<boolean> {
  const kind = classifyEnvelopeObject(envelope.object);
  const validated = validateSignedEnvelope(envelope, kind) as SignedSystemRecordEnvelopeV1<T>;
  const publicKey = decodeUnpaddedBase64UrlV1(
    validated.object.peerPublicKey,
    SYSTEM_RECORD_ED25519_PUBLIC_KEY_BYTES,
    'peerPublicKey',
  );
  for (const entry of validated.signatures) {
    const message = buildSystemRecordSignatureMessageV1(
      validated.object,
      validated.objectDigest,
      entry.role,
    );
    if (entry.role === 'peer') {
      const signature = decodeUnpaddedBase64UrlV1(
        entry.signature,
        SYSTEM_RECORD_ED25519_SIGNATURE_BYTES,
        'Ed25519 signature',
      );
      if (!await verifyEd25519(signature, message, publicKey)) return false;
      continue;
    }
    const personalHash = eip191PersonalMessageHashV1(message);
    if (entry.suite === 'eip191-personal-sign-digest-v1') {
      if (recoverEip191SignerV1(entry.signature, personalHash) !== entry.signer) return false;
    } else if (options.verifyEip1271 === undefined
      || !await options.verifyEip1271(entry, personalHash)) {
      return false;
    }
  }
  return true;
}

export function eip191PersonalMessageHashV1(message: Uint8Array): Uint8Array {
  const prefix = UTF8.encode(`\x19Ethereum Signed Message:\n${message.byteLength}`);
  return keccak256(concatBytes(prefix, message));
}

export function recoverEip191SignerV1(signature: string, personalHash: Uint8Array): string {
  assertCanonicalEip191SignatureV1(signature);
  if (personalHash.byteLength !== 32) fail('system-record-signature', 'personal message hash must be 32 bytes');
  try {
    const bytes = hexToBytes(signature);
    const compact = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), 'compact')
      .addRecoveryBit(bytes[64] - 27);
    const publicKey = compact.recoverPublicKey(personalHash).toBytes(false);
    return `0x${Buffer.from(keccak256(publicKey.subarray(1)).subarray(12)).toString('hex')}`;
  } catch (cause) {
    fail('system-record-signature', 'EIP-191 signature recovery failed', cause);
  }
}

export type SystemRecordAuthorityDecisionV1 =
  | { readonly decision: 'accept' }
  | { readonly decision: 'stale' }
  | { readonly decision: 'quarantine'; readonly reason: 'head-fork' | 'transition-equivocation' }
  | { readonly decision: 'reject'; readonly reason: string };

export interface AgentProfileAppliedTransitionV1 {
  readonly priorAuthoritySequence: DecimalU64V1;
  readonly nextAuthoritySequence: DecimalU64V1;
  readonly transitionDigest: Digest32V1;
}

export interface AgentProfileAcceptedAuthorityStateV1 {
  readonly current?: AgentProfileHeadObjectV1;
  readonly disposition: 'discoverable' | 'head-fork-quarantined' | 'transition-equivocation-quarantined';
  readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[];
  /** Duplicate-free prior roots in authority-sequence order; current root is excluded. */
  readonly historicalRoots: readonly string[];
  /** Bounded local diagnostics only; never an authority-completeness predicate. */
  readonly frontierConflictHeads?: readonly AgentProfileHeadObjectV1[];
}

export interface AgentProfileHeadAdvanceEvidenceV1 {
  readonly nowMs: number;
  readonly acceptedTransition?: AgentProfileAuthorityTransitionV1;
  readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
  /** Opaque proof minted only by buildAgentProfileVerificationClosureV1. */
  readonly verifiedAuthoritySummary?: AgentProfileVerifiedAuthoritySummaryV1;
  readonly forkResolution?: AgentProfileForkResolutionV1;
  readonly forkEvidenceHeads?: readonly AgentProfileHeadObjectV1[];
  readonly forkBaseHead?: AgentProfileHeadObjectV1;
}

export function evaluateAuthorityTransitionV1(
  transition: AgentProfileAuthorityTransitionV1,
  priorHead: AgentProfileHeadObjectV1,
  nowMs: number,
): SystemRecordAuthorityDecisionV1 {
  validateAuthorityTransition(transition);
  validateAgentProfileHeadObjectV1(priorHead);
  if (!isSafeNow(nowMs)) return { decision: 'reject', reason: 'verification clock is invalid' };
  if (isIssuedTooFarInFuture(transition.issuedAt, nowMs)) {
    return { decision: 'reject', reason: 'transition issuedAt exceeds the future clock-skew bound' };
  }
  const priorDigest = computeAgentProfileHeadObjectDigestV1(priorHead);
  if (transition.networkId !== priorHead.networkId
    || transition.peerId !== priorHead.peerId
    || transition.peerPublicKey !== priorHead.peerPublicKey
    || transition.priorAuthoritySequence !== priorHead.authoritySequence
    || transition.priorHeadDigest !== priorDigest
    || transition.priorEvmIssuer !== priorHead.evmIssuer) {
    return { decision: 'reject', reason: 'transition does not bind the accepted predecessor' };
  }
  if (transition.mode === 'expired-prior') {
    if (priorHead.state !== 'active') {
      return { decision: 'reject', reason: 'expired-prior transition cannot resurrect a tombstone' };
    }
    if (transition.priorValidUntil !== priorHead.validUntil) {
      return { decision: 'reject', reason: 'expired-prior transition does not bind prior validity' };
    }
    if (!Number.isSafeInteger(nowMs)
      || nowMs < Date.parse(priorHead.validUntil) + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS) {
      return { decision: 'reject', reason: 'prior authority has not passed the expiry skew' };
    }
  }
  return { decision: 'accept' };
}

/** Bind a successor head to the exact accepted transition for the same stable record. */
export function isAgentProfileHeadBoundToAcceptedTransitionV1(
  head: AgentProfileHeadObjectV1,
  transition: AgentProfileAuthorityTransitionV1,
): boolean {
  validateAgentProfileHeadObjectV1(head);
  validateAuthorityTransition(transition);
  return head.networkId === transition.networkId
    && head.peerId === transition.peerId
    && head.peerPublicKey === transition.peerPublicKey
    && head.acceptedTransitionDigest === computeAgentProfileAuthorityTransitionDigestV1(transition)
    && head.authoritySequence === transition.nextAuthoritySequence
    && head.evmIssuer === transition.nextEvmIssuer
    && head.rootSubject === transition.nextRoot;
}

export function evaluateAgentProfileHeadAdvanceV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  candidate: AgentProfileHeadObjectV1,
  evidence: AgentProfileHeadAdvanceEvidenceV1,
): SystemRecordAuthorityDecisionV1 {
  validateAgentProfileHeadObjectV1(candidate);
  if (!isSafeNow(evidence.nowMs)) return { decision: 'reject', reason: 'verification clock is invalid' };
  if (isIssuedTooFarInFuture(candidate.issuedAt, evidence.nowMs)) {
    return { decision: 'reject', reason: 'head issuedAt exceeds the future clock-skew bound' };
  }
  const lineage = validateAppliedTransitionLineage(accepted.transitionLineage);
  const current = accepted.current;
  const historicalRoots = validateAcceptedRootHistoryV1(accepted, current, lineage);
  const candidateDigest = computeAgentProfileHeadObjectDigestV1(candidate);
  if (current === undefined) {
    if (accepted.disposition !== 'discoverable' || lineage.length !== 0) {
      return { decision: 'reject', reason: 'absent state cannot retain authority history or quarantine' };
    }
    if (candidate.state === 'active'
      && candidate.authoritySequence === '0'
      && candidate.version === '0') {
      return { decision: 'accept' };
    }
    const summary = evidence.verifiedAuthoritySummary;
    if (!(summary instanceof AgentProfileVerifiedAuthoritySummaryValueV1)
      || summary.candidateHeadDigest !== candidateDigest) {
      return { decision: 'reject', reason: 'cold noninitial head requires its verified authority closure' };
    }
    const summaryLineage = validateAppliedTransitionLineage(summary.transitionLineage);
    if (BigInt(summaryLineage.length) !== parseCanonicalDecimalU64(candidate.authoritySequence)
      || summary.historicalRoots.length !== summaryLineage.length) {
      return { decision: 'reject', reason: 'verified authority closure has incomplete lineage' };
    }
    if (candidate.state === 'tombstone') {
      const predecessor = summary.tombstonePredecessor;
      if (predecessor === undefined || !isTombstoneBoundToPredecessorV1(candidate, predecessor)
        || summary.deletionTableDigest !== predecessor.ownedSubjectTableDigest) {
        return { decision: 'reject', reason: 'cold tombstone closure lacks its exact deletion predecessor' };
      }
    } else if (summary.tombstonePredecessor !== undefined
      || summary.deletionTableDigest !== undefined) {
      return { decision: 'reject', reason: 'active closure contains tombstone-only authority evidence' };
    }
    return { decision: 'accept' };
  }
  validateAgentProfileHeadObjectV1(current);
  const currentSequence = parseCanonicalDecimalU64(current.authoritySequence);
  if (BigInt(lineage.length) !== currentSequence) {
    return { decision: 'reject', reason: 'accepted authority state has incomplete transition lineage' };
  }
  if (accepted.disposition === 'transition-equivocation-quarantined') {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  if (current.networkId !== candidate.networkId || current.peerId !== candidate.peerId) {
    return { decision: 'reject', reason: 'stable record key changed' };
  }
  const candidateSequence = parseCanonicalDecimalU64(candidate.authoritySequence);
  if (candidateSequence < currentSequence) return { decision: 'stale' };
  if (candidateSequence > currentSequence + 1n) {
    return { decision: 'reject', reason: 'authority history is incomplete' };
  }
  if (candidateSequence === currentSequence + 1n) {
    if (accepted.disposition === 'head-fork-quarantined') {
      return { decision: 'reject', reason: 'unresolved head fork cannot advance authority sequence' };
    }
    const transition = evidence.acceptedTransition;
    if (transition === undefined || candidate.acceptedTransitionDigest === undefined
      || candidate.acceptedTransitionDigest !== computeAgentProfileAuthorityTransitionDigestV1(transition)) {
      return { decision: 'reject', reason: 'exact accepted authority transition is missing' };
    }
    if (candidate.state === 'tombstone') {
      return { decision: 'reject', reason: 'next-sequence tombstone requires its exact same-sequence active predecessor' };
    }
    const transitionDecision = evaluateAuthorityTransitionV1(transition, current, evidence.nowMs);
    if (transitionDecision.decision !== 'accept') return transitionDecision;
    if (historicalRoots.includes(transition.nextRoot) || transition.nextRoot === current.rootSubject) {
      return { decision: 'reject', reason: 'authority transition reuses a root retained by this record' };
    }
    if (candidate.evmIssuer !== transition.nextEvmIssuer
      || candidate.rootSubject !== transition.nextRoot) {
      return { decision: 'reject', reason: 'next-sequence head does not bind transition issuer/root' };
    }
    const existing = lineage.find((entry) => entry.nextAuthoritySequence === candidate.authoritySequence);
    if (existing !== undefined && existing.transitionDigest !== candidate.acceptedTransitionDigest) {
      return { decision: 'quarantine', reason: 'transition-equivocation' };
    }
    return { decision: 'accept' };
  }
  if (candidate.evmIssuer !== current.evmIssuer || candidate.rootSubject !== current.rootSubject) {
    return { decision: 'reject', reason: 'same-sequence authority changed' };
  }
  const currentDigest = computeAgentProfileHeadObjectDigestV1(current);
  if (candidate.acceptedTransitionDigest !== current.acceptedTransitionDigest) {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  const currentVersion = parseCanonicalDecimalU64(current.version);
  const candidateVersion = parseCanonicalDecimalU64(candidate.version);
  if (candidate.state === 'tombstone') {
    const predecessor = evidence.tombstonePredecessor
      ?? (current.state === 'active' ? current : undefined);
    if (predecessor === undefined || !isTombstoneBoundToPredecessorV1(candidate, predecessor)) {
      return { decision: 'reject', reason: 'tombstone lacks its exact verified active predecessor' };
    }
    if (current.state === 'active') return { decision: 'accept' };
    if (candidateVersion !== currentVersion) {
      return candidateVersion < currentVersion ? { decision: 'accept' } : { decision: 'stale' };
    }
    if (candidateDigest === currentDigest) return { decision: 'stale' };
    return candidateDigest < currentDigest ? { decision: 'accept' } : { decision: 'stale' };
  }
  if (current.state === 'tombstone') {
    return { decision: 'reject', reason: 'tombstone is terminal within its authority sequence' };
  }
  if (candidateVersion < currentVersion) return { decision: 'stale' };
  if (candidateVersion === currentVersion) {
    return candidateDigest === currentDigest
      ? { decision: 'stale' }
      : { decision: 'quarantine', reason: 'head-fork' };
  }
  if (accepted.disposition === 'head-fork-quarantined') {
    const resolution = evidence.forkResolution;
    const conflicts = evidence.forkEvidenceHeads;
    if (resolution === undefined || conflicts === undefined
      || candidate.state !== 'active'
      || resolution.forkedVersion !== current.version
      || computeAgentProfileForkResolutionDigestV1(resolution) !== candidate.forkResolutionDigest
      || !isDirectResolvingSuccessorV1(candidate, resolution)) {
      return { decision: 'reject', reason: 'current frontier fork requires its exact direct resolving successor' };
    }
    if (isIssuedTooFarInFuture(resolution.issuedAt, evidence.nowMs)) {
      return { decision: 'reject', reason: 'fork resolution issuedAt exceeds the future clock-skew bound' };
    }
    assertAgentProfileForkResolutionEvidenceV1(resolution, conflicts, evidence.forkBaseHead);
    const resolutionTransitionDigest = conflicts[0]?.acceptedTransitionDigest;
    if (resolutionTransitionDigest !== current.acceptedTransitionDigest
      || (evidence.forkBaseHead !== undefined
        && evidence.forkBaseHead.acceptedTransitionDigest !== current.acceptedTransitionDigest)) {
      return { decision: 'quarantine', reason: 'transition-equivocation' };
    }
  } else if (candidate.forkResolutionDigest !== undefined) {
    return { decision: 'reject', reason: 'historical or unsolicited fork resolution is audit-only' };
  }
  return { decision: 'accept' };
}

export function isDirectResolvingSuccessorV1(
  successor: AgentProfileHeadObjectV1,
  resolution: AgentProfileForkResolutionV1,
): boolean {
  validateAgentProfileHeadObjectV1(successor);
  validateForkResolution(resolution);
  if (successor.networkId !== resolution.networkId
    || successor.peerId !== resolution.peerId
    || successor.peerPublicKey !== resolution.peerPublicKey
    || successor.evmIssuer !== resolution.evmIssuer
    || successor.authoritySequence !== resolution.authoritySequence
    || successor.forkResolutionDigest !== computeAgentProfileForkResolutionDigestV1(resolution)
    || parseCanonicalDecimalU64(successor.version) <= parseCanonicalDecimalU64(resolution.resolutionVersion)) {
    return false;
  }
  return resolution.forkedVersion === '0'
    ? successor.previousHeadDigest === undefined
    : successor.previousHeadDigest === resolution.forkBaseHeadDigest;
}

function isTombstoneBoundToPredecessorV1(
  tombstone: AgentProfileTombstoneHeadObjectV1,
  predecessor: AgentProfileActiveHeadObjectV1,
): boolean {
  validateAgentProfileHeadObjectV1(predecessor);
  return tombstone.previousHeadDigest === computeAgentProfileHeadObjectDigestV1(predecessor)
    && tombstone.networkId === predecessor.networkId
    && tombstone.peerId === predecessor.peerId
    && tombstone.peerPublicKey === predecessor.peerPublicKey
    && tombstone.authoritySequence === predecessor.authoritySequence
    && tombstone.acceptedTransitionDigest === predecessor.acceptedTransitionDigest
    && tombstone.evmIssuer === predecessor.evmIssuer
    && tombstone.rootSubject === predecessor.rootSubject
    && tombstone.projectionSchemaDigest === predecessor.projectionSchemaDigest
    && parseCanonicalDecimalU64(tombstone.version) > parseCanonicalDecimalU64(predecessor.version);
}

export function assertAgentProfileForkResolutionEvidenceV1(
  resolution: AgentProfileForkResolutionV1,
  evidenceHeads: readonly AgentProfileHeadObjectV1[],
  forkBase?: AgentProfileHeadObjectV1,
): void {
  validateForkResolution(resolution);
  if (evidenceHeads.length !== resolution.evidenceHeadDigests.length) {
    fail('system-record-history', 'fork resolution evidence set is incomplete');
  }
  const byDigest = new Map(evidenceHeads.map((head) => {
    validateAgentProfileHeadObjectV1(head);
    return [computeAgentProfileHeadObjectDigestV1(head), head] as const;
  }));
  if (byDigest.size !== evidenceHeads.length
    || resolution.evidenceHeadDigests.some((candidate) => !byDigest.has(candidate))) {
    fail('system-record-history', 'fork resolution evidence digests do not match supplied heads');
  }
  const forkedVersion = parseCanonicalDecimalU64(resolution.forkedVersion);
  const authoritySequence = parseCanonicalDecimalU64(resolution.authoritySequence);
  let baseDigest: Digest32V1 | undefined;
  if (forkedVersion === 0n) {
    if (forkBase !== undefined) fail('system-record-history', 'version-zero fork must not supply a base');
  } else {
    if (forkBase === undefined) fail('system-record-history', 'nonzero fork requires its common base');
    validateAgentProfileHeadObjectV1(forkBase);
    baseDigest = computeAgentProfileHeadObjectDigestV1(forkBase);
    if (forkBase.state !== 'active'
      || baseDigest !== resolution.forkBaseHeadDigest
      || forkBase.networkId !== resolution.networkId
      || forkBase.peerId !== resolution.peerId
      || forkBase.authoritySequence !== resolution.authoritySequence
      || forkBase.evmIssuer !== resolution.evmIssuer
      || parseCanonicalDecimalU64(forkBase.version) >= forkedVersion) {
      fail('system-record-history', 'fork base is not a verified lower same-authority head');
    }
  }
  const expectedTransitionDigest = evidenceHeads[0]?.acceptedTransitionDigest;
  if ((authoritySequence === 0n && expectedTransitionDigest !== undefined)
    || (authoritySequence > 0n && expectedTransitionDigest === undefined)) {
    fail('system-record-history', 'fork evidence has invalid accepted-transition lineage');
  }
  for (const head of evidenceHeads) {
    if (head.state !== 'active') {
      fail('system-record-history', 'fork resolution cannot use tombstone evidence');
    }
    if (head.acceptedTransitionDigest !== expectedTransitionDigest) {
      fail('system-record-history', 'fork evidence changed accepted-transition lineage');
    }
    if (head.networkId !== resolution.networkId
      || head.peerId !== resolution.peerId
      || head.peerPublicKey !== resolution.peerPublicKey
      || head.evmIssuer !== resolution.evmIssuer
      || head.authoritySequence !== resolution.authoritySequence
      || head.version !== resolution.forkedVersion
      || (forkedVersion === 0n
        ? head.previousHeadDigest !== undefined
        : head.previousHeadDigest !== baseDigest)) {
      fail('system-record-history', 'fork evidence head does not share the canonical fork tuple/base');
    }
  }
  if (forkBase !== undefined && forkBase.acceptedTransitionDigest !== expectedTransitionDigest) {
    fail('system-record-history', 'fork base changed accepted-transition lineage');
  }
}

export function evaluateAuthorityTransitionConflictV1(
  left: AgentProfileAuthorityTransitionV1,
  right: AgentProfileAuthorityTransitionV1,
): SystemRecordAuthorityDecisionV1 {
  validateAuthorityTransition(left);
  validateAuthorityTransition(right);
  if (left.networkId !== right.networkId || left.peerId !== right.peerId
    || left.priorAuthoritySequence !== right.priorAuthoritySequence
    || left.nextAuthoritySequence !== right.nextAuthoritySequence) {
    return { decision: 'reject', reason: 'transitions do not target the same authority tuple' };
  }
  return computeAgentProfileAuthorityTransitionDigestV1(left)
    === computeAgentProfileAuthorityTransitionDigestV1(right)
    ? { decision: 'stale' }
    : { decision: 'quarantine', reason: 'transition-equivocation' };
}

/** Compare a verified transition with durable accepted lineage, including late delivery. */
export function evaluateAuthorityTransitionAgainstAcceptedStateV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  transition: AgentProfileAuthorityTransitionV1,
  nowMs: number,
): SystemRecordAuthorityDecisionV1 {
  validateAuthorityTransition(transition);
  if (!isSafeNow(nowMs) || isIssuedTooFarInFuture(transition.issuedAt, nowMs)) {
    return { decision: 'reject', reason: 'transition verification time is invalid' };
  }
  const lineage = validateAppliedTransitionLineage(accepted.transitionLineage);
  const current = accepted.current;
  const historicalRoots = validateAcceptedRootHistoryV1(accepted, current, lineage);
  if (current !== undefined
    && BigInt(lineage.length) !== parseCanonicalDecimalU64(current.authoritySequence)) {
    return { decision: 'reject', reason: 'accepted authority state has incomplete transition lineage' };
  }
  const digestValue = computeAgentProfileAuthorityTransitionDigestV1(transition);
  const retained = lineage.find(
    (entry) => entry.priorAuthoritySequence === transition.priorAuthoritySequence
      && entry.nextAuthoritySequence === transition.nextAuthoritySequence,
  );
  if (retained !== undefined) {
    return retained.transitionDigest === digestValue
      ? { decision: 'stale' }
      : { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  if (accepted.disposition === 'transition-equivocation-quarantined') {
    return { decision: 'quarantine', reason: 'transition-equivocation' };
  }
  if (accepted.disposition === 'head-fork-quarantined') {
    return { decision: 'reject', reason: 'unresolved head fork cannot advance authority sequence' };
  }
  if (current === undefined) {
    return { decision: 'reject', reason: 'transition has no accepted predecessor' };
  }
  if (historicalRoots.includes(transition.nextRoot) || transition.nextRoot === current.rootSubject) {
    return { decision: 'reject', reason: 'authority transition reuses a root retained by this record' };
  }
  return evaluateAuthorityTransitionV1(transition, current, nowMs);
}

export interface SystemRecordVerificationClosureObjectV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly digest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
  readonly references: readonly Pick<SystemRecordVerificationClosureObjectV1, 'objectKind' | 'digest'>[];
}

export interface SystemRecordVerificationClosureV1 {
  readonly objects: readonly SystemRecordVerificationClosureObjectV1[];
  readonly canonicalBytes: number;
  readonly rootClaims: number;
  readonly resolvedForkTuples: number;
  readonly authoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
}

class AgentProfileVerifiedAuthoritySummaryValueV1 {
  private declare readonly __opaqueAgentProfileVerifiedAuthoritySummaryV1: void;

  constructor(
    public readonly candidateHeadDigest: Digest32V1,
    public readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[],
    public readonly historicalRoots: readonly string[],
    public readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1,
    public readonly deletionTableDigest?: Digest32V1,
  ) {
    Object.freeze(this);
  }
}

/**
 * Process-local, non-serializable authority capability minted only by closure verification.
 * Consume it with this physical package instance; copying, persistence, worker transfer, or
 * reconstruction intentionally destroys its authority.
 */
export type AgentProfileVerifiedAuthoritySummaryV1 = AgentProfileVerifiedAuthoritySummaryValueV1;

export interface SystemRecordClosureArtifactV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly digest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
}

export interface AgentProfileClosureVerifierV1 {
  readonly nowMs: number;
  readonly resolve: (
    reference: Readonly<Pick<SystemRecordClosureArtifactV1, 'objectKind' | 'digest'>>,
  ) => Promise<SystemRecordClosureArtifactV1 | undefined>;
  readonly verifyAuthorityEnvelope: (
    envelope: SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1,
  ) => boolean | Promise<boolean>;
  readonly verifyCurrentBundle: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
  ) => boolean | Promise<boolean>;
}

type ClosurePurposeV1 =
  | 'current'
  | 'history'
  | 'fork-evidence'
  | 'tombstone-predecessor'
  | 'deletion-predecessor';

/**
 * Derive the row closure from canonical objects rather than trusting caller-supplied edges.
 * Authority and current-bundle verification stay injected because final chain/seal proofs
 * belong to later stacks, but a false/missing verifier result always fails closed.
 */
export async function buildAgentProfileVerificationClosureV1(
  currentHeadDigest: Digest32V1,
  verifier: AgentProfileClosureVerifierV1,
): Promise<SystemRecordVerificationClosureV1> {
  digest(currentHeadDigest, 'currentHeadDigest');
  if (!isSafeNow(verifier.nowMs)) fail('system-record-closure', 'closure verifier clock is invalid');
  const pending = new Map<string, {
    objectKind: SystemRecordObjectKindV1;
    digest: Digest32V1;
    purpose: ClosurePurposeV1;
    rootSubject?: string;
    referencedByHeadDigest?: Digest32V1;
  }>();
  const artifacts: SystemRecordVerificationClosureObjectV1[] = [];
  const parsedHeads = new Map<Digest32V1, AgentProfileHeadObjectV1>();
  const parsedTransitions = new Map<Digest32V1, AgentProfileAuthorityTransitionV1>();
  const parsedResolutions: AgentProfileForkResolutionV1[] = [];
  const seen = new Map<Digest32V1, SystemRecordObjectKindV1>();
  const rootClaims = new Set<string>();
  let bytes = 0;
  enqueue('agent-profile-head', currentHeadDigest, 'current');

  while (pending.size > 0) {
    const context = [...pending.values()].sort(compareClosureObjects)[0];
    const key = context.digest;
    pending.delete(key);
    const seenKind = seen.get(key);
    if (seenKind !== undefined) {
      if (seenKind !== context.objectKind) {
        fail('system-record-closure', 'one closure digest was presented under different object kinds');
      }
      continue;
    }
    const artifact = await verifier.resolve(context);
    if (artifact === undefined) fail('system-record-closure', `verification closure is missing ${key}`);
    if (artifact.objectKind !== context.objectKind || artifact.digest !== context.digest) {
      fail('system-record-closure', 'closure resolver returned a different artifact');
    }
    if (!(artifact.canonicalBytes instanceof Uint8Array)
      || artifact.canonicalBytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1[artifact.objectKind]) {
      fail('system-record-closure', 'closure artifact exceeds its kind cap');
    }
    const references: Pick<SystemRecordVerificationClosureObjectV1, 'objectKind' | 'digest'>[] = [];
    const add = (
      objectKind: SystemRecordObjectKindV1,
      objectDigest: Digest32V1,
      purpose: ClosurePurposeV1,
      rootSubject?: string,
      referencedByHeadDigest?: Digest32V1,
    ) => {
      enqueue(objectKind, objectDigest, purpose, rootSubject, referencedByHeadDigest);
      references.push({ objectKind, digest: objectDigest });
    };

    if (artifact.objectKind === 'agent-profile-head') {
      const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(artifact.canonicalBytes);
      if (envelope.objectDigest !== artifact.digest
        || !await verifier.verifyAuthorityEnvelope(envelope)) {
        fail('system-record-closure', 'head authority verification failed');
      }
      const head = envelope.object;
      if (isIssuedTooFarInFuture(head.issuedAt, verifier.nowMs)) {
        fail('system-record-closure', 'head issuedAt exceeds the future clock-skew bound');
      }
      parsedHeads.set(artifact.digest, head);
      rootClaims.add(head.rootSubject);
      if (head.acceptedTransitionDigest !== undefined) {
        add('authority-transition', head.acceptedTransitionDigest, 'history', undefined, artifact.digest);
      }
      if (head.forkResolutionDigest !== undefined) {
        add('fork-resolution', head.forkResolutionDigest, 'history', undefined, artifact.digest);
      }
      if (context.purpose === 'current' && head.state === 'active') {
        add('profile-bundle', head.bundleDigest, 'current');
      }
      if (head.state === 'tombstone') {
        add(
          'agent-profile-head',
          head.previousHeadDigest,
          context.purpose === 'current' ? 'deletion-predecessor' : 'tombstone-predecessor',
        );
      }
      if (context.purpose === 'deletion-predecessor' || context.purpose === 'tombstone-predecessor') {
        if (head.state !== 'active') fail('system-record-closure', 'tombstone predecessor must be active');
        if (context.purpose === 'deletion-predecessor') {
          add('owned-subject-table', head.ownedSubjectTableDigest, 'history', head.rootSubject);
        }
      }
    } else if (artifact.objectKind === 'authority-transition') {
      const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(artifact.canonicalBytes);
      if (envelope.objectDigest !== artifact.digest
        || !await verifier.verifyAuthorityEnvelope(envelope)) {
        fail('system-record-closure', 'authority-transition verification failed');
      }
      parsedTransitions.set(artifact.digest, envelope.object);
      if (context.referencedByHeadDigest !== undefined) {
        const referencingHead = parsedHeads.get(context.referencedByHeadDigest);
        if (referencingHead === undefined
          || !isAgentProfileHeadBoundToAcceptedTransitionV1(referencingHead, envelope.object)) {
          fail('system-record-closure', 'head does not bind its accepted authority transition');
        }
      }
      rootClaims.add(envelope.object.nextRoot);
      add('agent-profile-head', envelope.object.priorHeadDigest, 'history');
    } else if (artifact.objectKind === 'fork-resolution') {
      const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(artifact.canonicalBytes);
      if (envelope.objectDigest !== artifact.digest
        || !await verifier.verifyAuthorityEnvelope(envelope)) {
        fail('system-record-closure', 'fork-resolution verification failed');
      }
      parsedResolutions.push(envelope.object);
      if (isIssuedTooFarInFuture(envelope.object.issuedAt, verifier.nowMs)) {
        fail('system-record-closure', 'fork resolution issuedAt exceeds the future clock-skew bound');
      }
      if (context.referencedByHeadDigest !== undefined) {
        const referencingHead = parsedHeads.get(context.referencedByHeadDigest);
        if (referencingHead === undefined || !isDirectResolvingSuccessorV1(referencingHead, envelope.object)) {
          fail('system-record-closure', 'current head is not the direct successor of its fork resolution');
        }
      }
      for (const headDigest of envelope.object.evidenceHeadDigests) {
        add('agent-profile-head', headDigest, 'fork-evidence');
      }
      if (envelope.object.forkBaseHeadDigest !== undefined) {
        add('agent-profile-head', envelope.object.forkBaseHeadDigest, 'history');
      }
    } else if (artifact.objectKind === 'profile-bundle') {
      const current = parsedHeads.get(currentHeadDigest);
      if (current?.state !== 'active'
        || digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, artifact.canonicalBytes)
          !== artifact.digest
        || !await verifier.verifyCurrentBundle(current, artifact.canonicalBytes)) {
        fail('system-record-closure', 'current profile bundle verification failed');
      }
    } else if (artifact.objectKind === 'owned-subject-table') {
      if (context.rootSubject === undefined) fail('system-record-closure', 'subject table lacks root context');
      const table = parseCanonicalOwnedSubjectTableObjectV1(context.rootSubject, artifact.canonicalBytes);
      if (computeOwnedSubjectTableDigestV1(context.rootSubject, table) !== artifact.digest) {
        fail('system-record-closure', 'owned-subject table digest mismatch');
      }
    } else {
      fail('system-record-closure', `${artifact.objectKind} is not part of an advertised row closure`);
    }

    bytes += artifact.canonicalBytes.byteLength;
    if (artifacts.length + 1 > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS
      || bytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES
      || rootClaims.size > SYSTEM_RECORD_MAX_ROOT_CLAIMS
      || parsedResolutions.length > SYSTEM_RECORD_MAX_RESOLVED_FORK_TUPLES) {
      fail('system-record-closure', 'verification closure exceeds a V1 bound');
    }
    seen.set(key, artifact.objectKind);
    artifacts.push(Object.freeze({
      objectKind: artifact.objectKind,
      digest: artifact.digest,
      canonicalBytes: artifact.canonicalBytes.slice(),
      references: Object.freeze(references.sort(compareClosureObjects)),
    }));
    if (seen.size + pending.size > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
      fail('system-record-closure', 'verification closure cannot fit before dependency fetch');
    }
  }

  for (const resolution of parsedResolutions) {
    const evidence = resolution.evidenceHeadDigests.map((headDigest) => parsedHeads.get(headDigest));
    if (evidence.some((head) => head === undefined)) {
      fail('system-record-closure', 'fork evidence is incomplete after traversal');
    }
    const base = resolution.forkBaseHeadDigest === undefined
      ? undefined
      : parsedHeads.get(resolution.forkBaseHeadDigest);
    assertAgentProfileForkResolutionEvidenceV1(
      resolution,
      evidence as AgentProfileHeadObjectV1[],
      base,
    );
    const transitionDigest = (evidence as AgentProfileHeadObjectV1[])[0].acceptedTransitionDigest;
    const resolutionDigest = computeAgentProfileForkResolutionDigestV1(resolution);
    for (const head of parsedHeads.values()) {
      if (head.forkResolutionDigest === resolutionDigest
        && head.acceptedTransitionDigest !== transitionDigest) {
        fail('system-record-closure', 'resolving successor changed accepted-transition lineage');
      }
    }
  }
  const transitionTupleDigests = new Map<string, Digest32V1>();
  for (const [transitionDigest, transition] of parsedTransitions) {
    const prior = parsedHeads.get(transition.priorHeadDigest);
    if (prior === undefined
      || evaluateAuthorityTransitionV1(transition, prior, verifier.nowMs).decision !== 'accept') {
      fail('system-record-closure', `authority transition ${transitionDigest} lacks its exact accepted predecessor`);
    }
    const tuple = [
      transition.networkId,
      transition.peerId,
      transition.priorAuthoritySequence,
      transition.nextAuthoritySequence,
    ].join('\u0000');
    const priorDigest = transitionTupleDigests.get(tuple);
    if (priorDigest !== undefined && priorDigest !== transitionDigest) {
      fail('system-record-closure', 'verification closure contains authority-transition equivocation');
    }
    transitionTupleDigests.set(tuple, transitionDigest);
  }
  for (const [headDigest, head] of parsedHeads) {
    assertCompleteUniqueRootLineage(headDigest, head);
    if (head.acceptedTransitionDigest !== undefined) {
      const transition = parsedTransitions.get(head.acceptedTransitionDigest);
      if (transition === undefined
        || !isAgentProfileHeadBoundToAcceptedTransitionV1(head, transition)) {
        fail('system-record-closure', `head ${headDigest} does not bind its accepted transition`);
      }
    }
    if (head.forkResolutionDigest !== undefined) {
      const resolution = parsedResolutions.find(
        (candidate) => computeAgentProfileForkResolutionDigestV1(candidate) === head.forkResolutionDigest,
      );
      if (resolution === undefined || !isDirectResolvingSuccessorV1(head, resolution)) {
        fail('system-record-closure', `head ${headDigest} does not directly bind its fork resolution`);
      }
    }
  }
  for (const head of parsedHeads.values()) {
    if (head.state === 'tombstone') {
      const predecessor = parsedHeads.get(head.previousHeadDigest);
      if (predecessor?.state !== 'active' || !isTombstoneBoundToPredecessorV1(head, predecessor)) {
        fail('system-record-closure', 'tombstone predecessor is not the exact prior active authority state');
      }
    }
  }
  const authoritySummary = createVerifiedAuthoritySummary();
  artifacts.sort(compareClosureObjects);
  return Object.freeze({
    objects: Object.freeze(artifacts),
    canonicalBytes: bytes,
    rootClaims: rootClaims.size,
    resolvedForkTuples: parsedResolutions.length,
    authoritySummary,
  });

  function enqueue(
    objectKind: SystemRecordObjectKindV1,
    objectDigest: Digest32V1,
    purpose: ClosurePurposeV1,
    rootSubject?: string,
    referencedByHeadDigest?: Digest32V1,
  ): void {
    digest(objectDigest, 'closure reference digest');
    const key = objectDigest;
    const seenKind = seen.get(key);
    if (seenKind !== undefined) {
      if (seenKind !== objectKind) {
        fail('system-record-closure', 'one closure digest was referenced under different object kinds');
      }
      return;
    }
    const existing = pending.get(key);
    if (existing !== undefined && existing.objectKind !== objectKind) {
      fail('system-record-closure', 'one pending closure digest has conflicting object kinds');
    }
    const priority: Record<ClosurePurposeV1, number> = {
      history: 0, 'fork-evidence': 1,
      'tombstone-predecessor': 2, 'deletion-predecessor': 3, current: 4,
    };
    if (existing === undefined || priority[purpose] > priority[existing.purpose]) {
      pending.set(key, {
        objectKind,
        digest: objectDigest,
        purpose,
        ...(rootSubject === undefined ? {} : { rootSubject }),
        ...(referencedByHeadDigest === undefined ? {} : { referencedByHeadDigest }),
      });
    }
  }

  function assertCompleteUniqueRootLineage(
    headDigest: Digest32V1,
    head: AgentProfileHeadObjectV1,
  ): void {
    let cursor = head;
    let sequence = parseCanonicalDecimalU64(head.authoritySequence);
    const roots = new Set<string>([head.rootSubject]);
    for (let depth = 0; sequence > 0n; depth += 1) {
      if (depth >= Number(SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX)
        || cursor.acceptedTransitionDigest === undefined) {
        fail('system-record-history', `head ${headDigest} has incomplete authority/root lineage`);
      }
      const transition = parsedTransitions.get(cursor.acceptedTransitionDigest);
      const prior = transition === undefined ? undefined : parsedHeads.get(transition.priorHeadDigest);
      if (transition === undefined || prior === undefined
        || parseCanonicalDecimalU64(transition.nextAuthoritySequence) !== sequence
        || parseCanonicalDecimalU64(prior.authoritySequence) + 1n !== sequence) {
        fail('system-record-history', `head ${headDigest} has incomplete authority/root lineage`);
      }
      if (roots.has(prior.rootSubject)) {
        fail('system-record-history', `head ${headDigest} reuses a historical wallet root`);
      }
      roots.add(prior.rootSubject);
      cursor = prior;
      sequence -= 1n;
    }
    if (cursor.acceptedTransitionDigest !== undefined) {
      fail('system-record-history', `head ${headDigest} has authority evidence below sequence zero`);
    }
  }

  function createVerifiedAuthoritySummary(): AgentProfileVerifiedAuthoritySummaryV1 {
    const current = parsedHeads.get(currentHeadDigest);
    if (current === undefined) fail('system-record-closure', 'verified closure lost its current head');
    const reverseLineage: AgentProfileAppliedTransitionV1[] = [];
    const reverseRoots: string[] = [];
    let cursor = current;
    let sequence = parseCanonicalDecimalU64(current.authoritySequence);
    while (sequence > 0n) {
      const transition = cursor.acceptedTransitionDigest === undefined
        ? undefined
        : parsedTransitions.get(cursor.acceptedTransitionDigest);
      const prior = transition === undefined ? undefined : parsedHeads.get(transition.priorHeadDigest);
      if (transition === undefined || prior === undefined) {
        fail('system-record-history', 'verified closure lost its authority lineage');
      }
      reverseLineage.push(Object.freeze({
        priorAuthoritySequence: transition.priorAuthoritySequence,
        nextAuthoritySequence: transition.nextAuthoritySequence,
        transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
      }));
      reverseRoots.push(prior.rootSubject);
      cursor = prior;
      sequence -= 1n;
    }
    const tombstonePredecessor = current.state === 'tombstone'
      ? parsedHeads.get(current.previousHeadDigest)
      : undefined;
    if (tombstonePredecessor !== undefined && tombstonePredecessor.state !== 'active') {
      fail('system-record-history', 'verified tombstone closure lost its active predecessor');
    }
    return new AgentProfileVerifiedAuthoritySummaryValueV1(
      currentHeadDigest,
      Object.freeze(reverseLineage.reverse()),
      Object.freeze(reverseRoots.reverse()),
      tombstonePredecessor?.state === 'active' ? tombstonePredecessor : undefined,
      tombstonePredecessor?.ownedSubjectTableDigest,
    );
  }
}

function compareClosureObjects(
  left: Pick<SystemRecordVerificationClosureObjectV1, 'objectKind' | 'digest'>,
  right: Pick<SystemRecordVerificationClosureObjectV1, 'objectKind' | 'digest'>,
): number {
  if (left.digest !== right.digest) return left.digest < right.digest ? -1 : 1;
  if (left.objectKind === right.objectKind) return 0;
  return left.objectKind < right.objectKind ? -1 : 1;
}

export function assertSystemRecordClosureAlgebraV1(
  authoritySequence: bigint,
  mode: 'active' | 'tombstone' | 'fork',
  conflictHeads = 0,
): number {
  if (authoritySequence < 0n || authoritySequence > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    fail('system-record-closure', 'authority sequence is outside V1');
  }
  let objects = mode === 'active'
    ? 2 + Number(authoritySequence) * 2
    : mode === 'tombstone'
      ? 3 + Number(authoritySequence) * 2
      : 4 + Number(authoritySequence) * 2 + conflictHeads;
  if (mode === 'fork' && (conflictHeads < 2 || conflictHeads > SYSTEM_RECORD_MAX_CONFLICT_DIGESTS)) {
    fail('system-record-closure', 'fork closure needs 2-16 evidence heads');
  }
  if (objects > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
    fail('system-record-closure', `closure requires ${objects} objects, over the V1 cap`);
  }
  return objects;
}

const READ_SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1 = Symbol('system-record-cache-reference-facts-v1');

class SystemRecordCacheReferenceValueV1 {
  readonly #facts: SystemRecordCacheReferenceFactsV1;

  constructor(
  /** Semantic object identity used by authority, closure edges, and inventory rows. */
    public readonly digest: Digest32V1,
  /** Exact physical cache identity; signed controls bind their complete envelope bytes. */
    public readonly cacheDigest: Digest32V1,
    public readonly objectKind: SystemRecordObjectKindV1,
    facts: SystemRecordCacheReferenceFactsV1,
  ) {
    this.#facts = Object.freeze({ ...facts });
    Object.freeze(this);
  }

  [READ_SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1](): SystemRecordCacheReferenceFactsV1 {
    return this.#facts;
  }
}

/**
 * Process-local, factory-only accounting capability bound to exact canonical bytes.
 * It must not be reconstructed, cloned, serialized, or transferred between module instances.
 */
export type SystemRecordCacheReferenceV1 = SystemRecordCacheReferenceValueV1;

interface SystemRecordCacheReferenceFactsV1 {
  readonly byteLength: number;
  readonly fingerprint: string;
}

/** Create an exact byte-derived accounting reference; unbranded caller counters are rejected. */
export function createSystemRecordCacheReferenceV1(
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
  canonicalBytes: Uint8Array,
): SystemRecordCacheReferenceV1 {
  digest(objectDigest, 'cache reference digest');
  if (!(canonicalBytes instanceof Uint8Array)
    || canonicalBytes.byteLength < 1
    || !(objectKind in SYSTEM_RECORD_OBJECT_CAPS_V1)
    || canonicalBytes.byteLength > SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind]) {
    fail('system-record-closure', 'cache reference bytes exceed their object-kind cap');
  }
  const identities = deriveCacheReferenceArtifactIdentitiesV1(objectKind, canonicalBytes, 'cache reference');
  if (identities.semanticDigest !== objectDigest) {
    fail('system-record-closure', 'cache reference semantic digest does not bind its canonical bytes');
  }
  return new SystemRecordCacheReferenceValueV1(
    identities.semanticDigest,
    identities.cacheDigest,
    objectKind,
    {
    byteLength: canonicalBytes.byteLength,
    fingerprint: Buffer.from(sha256(canonicalBytes)).toString('hex'),
    },
  );
}

export interface SystemRecordCacheRowAccountingV1 {
  readonly closure: readonly SystemRecordCacheReferenceV1[];
  readonly sidecar?: readonly SystemRecordCacheReferenceV1[];
  readonly metadata: SystemRecordCacheMetadataV1;
  readonly sidecarMetadata?: SystemRecordCacheMetadataV1;
}

const READ_SYSTEM_RECORD_CACHE_METADATA_BYTES_V1 = Symbol('system-record-cache-metadata-bytes-v1');

class SystemRecordCacheMetadataValueV1 {
  readonly #byteLength: number;

  constructor(byteLength: number) {
    this.#byteLength = byteLength;
    Object.freeze(this);
  }

  [READ_SYSTEM_RECORD_CACHE_METADATA_BYTES_V1](): number {
    return this.#byteLength;
  }
}

/**
 * Process-local, factory-only metadata accounting capability. Serialization or cloning
 * intentionally loses the private byte-accounting authority.
 */
export type SystemRecordCacheMetadataV1 = SystemRecordCacheMetadataValueV1;

/** Brand the exact encoded metadata bytes that B2 will include in its atomic baseline preflight. */
export function createSystemRecordCacheMetadataV1(
  encodedMetadata: Uint8Array,
): SystemRecordCacheMetadataV1 {
  if (!(encodedMetadata instanceof Uint8Array)
    || encodedMetadata.byteLength > SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES) {
    fail('system-record-closure', 'cache metadata bytes exceed the live metadata bound');
  }
  return new SystemRecordCacheMetadataValueV1(encodedMetadata.byteLength);
}

export interface SystemRecordCachePreflightResultV1 {
  /** Exact proposed cohort delta; B2 must combine it with its full physical-cache baseline. */
  readonly cohortPhysicalObjects: number;
  readonly cohortPhysicalBytes: number;
  readonly closureReferences: number;
  readonly closurePhysicalBytes: number;
  readonly closureReferencedBytes: number;
  readonly sidecarReferences: number;
  readonly sidecars: number;
  readonly sidecarPhysicalBytes: number;
  readonly sidecarReferencedBytes: number;
  readonly activationBundleBytes: number;
  readonly activationInventoryLeaves: number;
  readonly metadataBytes: number;
}

export interface SystemRecordCachePreflightInputV1 {
  readonly mode: 'live' | 'activation';
  readonly rows: readonly SystemRecordCacheRowAccountingV1[];
  readonly inventoryLeaves?: readonly SystemRecordCacheReferenceV1[];
}

/** Pure all-or-nothing aggregate preflight; shared physical digests are charged once. */
export function preflightSystemRecordCacheAccountingV1(
  input: SystemRecordCachePreflightInputV1,
): SystemRecordCachePreflightResultV1 {
  const hasInventoryLeaves = hasOwnProperty(input, 'inventoryLeaves');
  const exact = snapshotExactDataRecord(
    input,
    ['mode', 'rows', ...(hasInventoryLeaves ? ['inventoryLeaves'] : [])],
    'cache preflight input',
  );
  if (exact.mode !== 'live' && exact.mode !== 'activation') {
    fail('system-record-closure', 'cache preflight mode is invalid');
  }
  const rows = exact.rows as readonly SystemRecordCacheRowAccountingV1[];
  if (!Array.isArray(rows)) fail('system-record-closure', 'cache rows must be an array');
  if (rows.length > SYSTEM_RECORD_MAX_INVENTORY_RECORDS
    || (exact.mode === 'activation' && rows.length > SYSTEM_RECORD_MAX_ACTIVATION_RECORDS)) {
    fail('system-record-closure', 'cache cohort exceeds its record bound');
  }
  const inventoryLeaves = (hasInventoryLeaves ? exact.inventoryLeaves : []) as readonly SystemRecordCacheReferenceV1[];
  if (!Array.isArray(inventoryLeaves)) {
    fail('system-record-closure', 'activation inventory leaves must be an array');
  }
  if (exact.mode === 'live' && inventoryLeaves.length !== 0) {
    fail('system-record-closure', 'live preflight must not carry activation inventory leaves');
  }
  if (inventoryLeaves.length > SYSTEM_RECORD_MAX_ACTIVATION_INVENTORY_LEAVES) {
    fail('system-record-closure', 'activation inventory exceeds its leaf bound');
  }
  const physical = new Map<Digest32V1, { reference: SystemRecordCacheReferenceV1; facts: SystemRecordCacheReferenceFactsV1 }>();
  const closurePhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  const sidecarPhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  const bundlePhysical = new Map<Digest32V1, SystemRecordCacheReferenceFactsV1>();
  let closureReferences = 0;
  let closureReferencedBytes = 0;
  let sidecarReferences = 0;
  let sidecars = 0;
  let sidecarReferencedBytes = 0;
  let metadataBytes = 0;
  let sidecarMetadataBytes = 0;
  for (const row of rows) {
    const hasSidecar = hasOwnProperty(row, 'sidecar');
    const hasSidecarMetadata = hasOwnProperty(row, 'sidecarMetadata');
    const exactRow = snapshotExactDataRecord(
      row,
      [
        'closure',
        'metadata',
        ...(hasSidecar ? ['sidecar'] : []),
        ...(hasSidecarMetadata ? ['sidecarMetadata'] : []),
      ],
      'cache accounting row',
    );
    const closure = exactRow.closure as readonly SystemRecordCacheReferenceV1[];
    const sidecar = (hasSidecar ? exactRow.sidecar : undefined) as
      | readonly SystemRecordCacheReferenceV1[]
      | undefined;
    const rowMetadataBytes = requireCacheMetadataBytes(exactRow.metadata, 'cache row metadata');
    if (hasSidecar !== hasSidecarMetadata) {
      fail('system-record-closure', 'cache row sidecar and sidecar metadata must be present together');
    }
    const rowSidecarMetadataBytes = hasSidecarMetadata
      ? requireCacheMetadataBytes(exactRow.sidecarMetadata, 'cache row sidecar metadata')
      : 0;
    if (!Array.isArray(closure)) {
      fail('system-record-closure', 'cache row closure must be an array');
    }
    if (hasSidecar && !Array.isArray(sidecar)) {
      fail('system-record-closure', 'cache row sidecar must be an array');
    }
    if (closure.length > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
      fail('system-record-closure', 'row closure exceeds its object bound');
    }
    const rowClosureBytes = accountReferences(closure, closurePhysical, 'closure');
    if (rowClosureBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES) {
      fail('system-record-closure', 'row closure exceeds its byte bound');
    }
    closureReferences += closure.length;
    closureReferencedBytes += rowClosureBytes;
    if (!Number.isSafeInteger(closureReferences) || !Number.isSafeInteger(closureReferencedBytes)) {
      fail('system-record-closure', 'aggregate closure accounting overflow');
    }
    for (const reference of closure) {
      if (reference.objectKind === 'profile-bundle') {
        bundlePhysical.set(reference.cacheDigest, requireCacheReferenceFacts(reference, 'closure'));
      }
    }
    if (sidecar !== undefined) {
      sidecars += 1;
      if (sidecar.length > SYSTEM_RECORD_MAX_SIDECAR_OBJECTS) {
        fail('system-record-closure', 'row sidecar exceeds its object bound');
      }
      const rowSidecarBytes = accountReferences(sidecar, sidecarPhysical, 'sidecar');
      if (sidecar.filter((reference) => reference.objectKind === 'conflict-evidence').length !== 1
        || sidecar.some((reference) => reference.objectKind !== 'conflict-evidence'
          && reference.objectKind !== 'agent-profile-head'
          && reference.objectKind !== 'authority-transition'
          && reference.objectKind !== 'fork-resolution')) {
        fail('system-record-closure', 'row sidecar must contain one evidence object and only signed controls');
      }
      if (rowSidecarBytes > SYSTEM_RECORD_MAX_SIDECAR_BYTES) {
        fail('system-record-closure', 'row sidecar exceeds its byte bound');
      }
      sidecarReferences += sidecar.length;
      sidecarReferencedBytes += rowSidecarBytes;
      if (!Number.isSafeInteger(sidecarReferences) || !Number.isSafeInteger(sidecarReferencedBytes)) {
        fail('system-record-closure', 'aggregate sidecar accounting overflow');
      }
    }
    metadataBytes += rowMetadataBytes + rowSidecarMetadataBytes;
    sidecarMetadataBytes += rowSidecarMetadataBytes;
    if (!Number.isSafeInteger(metadataBytes)) fail('system-record-closure', 'cache metadata accounting overflow');
  }
  accountReferences(inventoryLeaves, new Map(), 'activation inventory');
  if (inventoryLeaves.some((reference) => reference.objectKind !== 'inventory-leaf')) {
    fail('system-record-closure', 'activation inventory may contain only leaf objects');
  }
  const physicalBytes = [...physical.values()].reduce((sum, entry) => sum + entry.facts.byteLength, 0);
  const closurePhysicalBytes = sumPhysicalBytes(closurePhysical);
  const sidecarPhysicalBytes = sumPhysicalBytes(sidecarPhysical);
  const closureSidecarPhysicalBytes = sumPhysicalBytes(new Map([
    ...closurePhysical,
    ...sidecarPhysical,
  ]));
  const activationBundleBytes = sumPhysicalBytes(bundlePhysical);
  if (closurePhysical.size > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS
    || closurePhysicalBytes > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES
    || closureReferences > SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES
    || metadataBytes > SYSTEM_RECORD_MAX_CLOSURE_SIDECAR_LIVE_METADATA_BYTES
    || sidecars > SYSTEM_RECORD_MAX_CONFLICT_SIDECARS
    || sidecarReferences > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES
    || sidecarPhysicalBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES
    || sidecarMetadataBytes > SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_METADATA_BYTES) {
    fail('system-record-closure', 'aggregate cache accounting exceeds a live V1 bound');
  }
  if (exact.mode === 'activation' && (activationBundleBytes > SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES
    || closureSidecarPhysicalBytes > SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES
    || closureReferences + sidecarReferences + inventoryLeaves.length > SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES
    || metadataBytes > SYSTEM_RECORD_MAX_ACTIVATION_METADATA_BYTES)) {
    fail('system-record-closure', 'activation cache accounting exceeds its cohort bound');
  }
  return Object.freeze({
    cohortPhysicalObjects: physical.size,
    cohortPhysicalBytes: physicalBytes,
    closureReferences,
    closurePhysicalBytes,
    closureReferencedBytes,
    sidecarReferences,
    sidecars,
    sidecarPhysicalBytes,
    sidecarReferencedBytes,
    activationBundleBytes,
    activationInventoryLeaves: inventoryLeaves.length,
    metadataBytes,
  });

  function accountReferences(
    references: readonly SystemRecordCacheReferenceV1[],
    category: Map<Digest32V1, SystemRecordCacheReferenceFactsV1>,
    label: string,
  ): number {
    if (!Array.isArray(references)) fail('system-record-closure', `${label} references must be an array`);
    let total = 0;
    const logical = new Set<string>();
    for (const reference of references as readonly SystemRecordCacheReferenceV1[]) {
      digest(reference.digest, `${label} digest`);
      digest(reference.cacheDigest, `${label} cache digest`);
      const logicalKey = `${reference.objectKind}:${reference.digest}`;
      if (logical.has(logicalKey)) {
        fail('system-record-closure', `${label} contains a duplicate semantic reference`);
      }
      logical.add(logicalKey);
      const facts = requireCacheReferenceFacts(reference, label);
      const prior = physical.get(reference.cacheDigest);
      if (prior !== undefined && (prior.reference.objectKind !== reference.objectKind
        || prior.reference.digest !== reference.digest
        || prior.facts.byteLength !== facts.byteLength
        || prior.facts.fingerprint !== facts.fingerprint)) {
        fail('system-record-closure', 'one cache digest was reported with conflicting canonical bytes');
      }
      physical.set(reference.cacheDigest, { reference, facts });
      category.set(reference.cacheDigest, facts);
      total += facts.byteLength;
      if (!Number.isSafeInteger(total)) fail('system-record-closure', `${label} byte accounting overflow`);
    }
    return total;
  }

  function sumPhysicalBytes(references: ReadonlyMap<Digest32V1, SystemRecordCacheReferenceFactsV1>): number {
    return [...references.values()].reduce((sum, facts) => sum + facts.byteLength, 0);
  }
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return value !== null
    && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, key);
}

function requireCacheMetadataBytes(value: unknown, label: string): number {
  if (!(value instanceof SystemRecordCacheMetadataValueV1)
    || Object.keys(value).length !== 0) {
    fail('system-record-closure', `${label} was not derived from encoded bytes`);
  }
  return value[READ_SYSTEM_RECORD_CACHE_METADATA_BYTES_V1]();
}

function requireCacheReferenceFacts(
  reference: SystemRecordCacheReferenceV1,
  label: string,
): SystemRecordCacheReferenceFactsV1 {
  if (!(reference instanceof SystemRecordCacheReferenceValueV1)
    || Object.keys(reference).sort().join('\u0000') !== 'cacheDigest\u0000digest\u0000objectKind') {
    fail('system-record-closure', `${label} reference was not derived from canonical bytes`);
  }
  digest(reference.digest, `${label} digest`);
  digest(reference.cacheDigest, `${label} cache digest`);
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_RECORD_OBJECT_CAPS_V1, reference.objectKind)) {
    fail('system-record-closure', `${label} object kind is invalid`);
  }
  return reference[READ_SYSTEM_RECORD_CACHE_REFERENCE_FACTS_V1]();
}

function deriveCacheReferenceArtifactIdentitiesV1(
  objectKind: SystemRecordObjectKindV1,
  canonicalBytes: Uint8Array,
  label: string,
): Readonly<{ semanticDigest: Digest32V1; cacheDigest: Digest32V1 }> {
  let semanticDigest: Digest32V1;
  let cacheDigest: Digest32V1;
  if (objectKind === 'agent-profile-head') {
    const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else if (objectKind === 'authority-transition') {
    const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else if (objectKind === 'fork-resolution') {
    const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(canonicalBytes);
    semanticDigest = envelope.objectDigest;
    cacheDigest = computeSignedSystemRecordEnvelopeDigestV1(envelope);
  } else {
    const domains: Record<Exclude<SystemRecordObjectKindV1,
      'agent-profile-head' | 'authority-transition' | 'fork-resolution'>, string> = {
      'root-descriptor': SYSTEM_RECORD_DIGEST_DOMAINS_V1.rootDescriptor,
      'inventory-internal': SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryInternal,
      'inventory-leaf': SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf,
      'conflict-evidence': SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence,
      'owned-subject-table': SYSTEM_RECORD_DIGEST_DOMAINS_V1.ownedSubjectTable,
      'profile-bundle': SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
    };
    semanticDigest = digestSystemRecordBytesV1(domains[objectKind], canonicalBytes);
    cacheDigest = semanticDigest;
  }
  if (semanticDigest.length !== 66 || cacheDigest.length !== 66) {
    fail('system-record-closure', `${label} artifact identity is invalid`);
  }
  return Object.freeze({ semanticDigest, cacheDigest });
}

function validateAppliedTransitionLineage(
  value: readonly AgentProfileAppliedTransitionV1[],
): readonly AgentProfileAppliedTransitionV1[] {
  if (!Array.isArray(value) || value.length > Number(SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX)) {
    fail('system-record-history', 'applied transition lineage exceeds the V1 bound');
  }
  let expectedPrior = 0n;
  for (const entry of value) {
    const exact = snapshotExactDataRecord(
      entry,
      ['priorAuthoritySequence', 'nextAuthoritySequence', 'transitionDigest'],
      'applied transition lineage entry',
    );
    const prior = u64(exact.priorAuthoritySequence, 'priorAuthoritySequence');
    const next = u64(exact.nextAuthoritySequence, 'nextAuthoritySequence');
    digest(exact.transitionDigest, 'transitionDigest');
    if (prior !== expectedPrior || next !== prior + 1n) {
      fail('system-record-history', 'applied transition lineage must be contiguous from sequence zero');
    }
    expectedPrior = next;
  }
  return value;
}

function validateAcceptedRootHistoryV1(
  accepted: AgentProfileAcceptedAuthorityStateV1,
  current: AgentProfileHeadObjectV1 | undefined,
  lineage: readonly AgentProfileAppliedTransitionV1[],
): readonly string[] {
  if (!Array.isArray(accepted.historicalRoots)) {
    fail('system-record-history', 'accepted authority state lacks its root history');
  }
  if (current === undefined) {
    if (accepted.historicalRoots.length !== 0) {
      fail('system-record-history', 'absent authority state cannot retain root history');
    }
    return accepted.historicalRoots;
  }
  if (accepted.historicalRoots.length !== lineage.length) {
    fail('system-record-history', 'accepted root history must match transition lineage');
  }
  const roots = new Set<string>([current.rootSubject]);
  for (const root of accepted.historicalRoots) {
    assertAgentRootV1(root);
    if (roots.has(root)) fail('system-record-history', 'accepted root history must be duplicate-free');
    roots.add(root);
  }
  return accepted.historicalRoots;
}

function isSafeNow(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0;
}

function isIssuedTooFarInFuture(issuedAt: CanonicalRfc3339SecondsV1, nowMs: number): boolean {
  return Date.parse(issuedAt) > nowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS;
}

function validateEip1271Evidence(value: unknown, issuer: string): void {
  const evidence = snapshotExactDataRecord(
    value,
    ['kind', 'chainId', 'contractAddress', 'finalizedBlockNumber', 'finalizedBlockHash'],
    'EIP-1271 evidence',
  );
  if (evidence.kind !== 'eip1271-current-finalized') {
    fail('system-record-signature', 'EIP-1271 evidence kind is invalid');
  }
  try {
    assertCanonicalChainId(evidence.chainId);
    assertCanonicalEvmAddress(evidence.contractAddress);
    assertCanonicalDecimalU64(evidence.finalizedBlockNumber);
    assertCanonicalDigest(evidence.finalizedBlockHash);
  } catch (cause) {
    fail('system-record-signature', 'EIP-1271 finalized evidence is invalid', cause);
  }
  if (evidence.contractAddress !== issuer) {
    fail('system-record-binding', 'EIP-1271 contract does not match signer');
  }
}

function exactNoneEvidence(value: unknown): void {
  const evidence = snapshotExactDataRecord(value, ['kind'], 'signature evidence');
  if (evidence.kind !== 'none') fail('system-record-signature', 'signature evidence must be none');
}

function issuerForRole(
  object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1,
  role: Exclude<SystemRecordSignatureRoleV1, 'peer'>,
): string {
  if (object.objectType === 'authority-transition') {
    if (role === 'prior-evm') return object.priorEvmIssuer;
    if (role === 'next-evm') return object.nextEvmIssuer;
  } else if (role === 'current-evm') {
    return object.evmIssuer;
  }
  fail('system-record-signature', `${role} is not valid for ${object.objectType}`);
}

function classifyEnvelopeObject(value: unknown): 'head' | 'transition' | 'fork' {
  const record = snapshotRecord(value, 'signed envelope object');
  if (record.objectType === 'agent-profile-head') return 'head';
  if (record.objectType === 'authority-transition') return 'transition';
  if (record.objectType === 'fork-resolution') return 'fork';
  fail('system-record-schema', 'signed envelope object type is unsupported');
}

function objectKindForEnvelope(
  value: 'head' | 'transition' | 'fork',
): 'agent-profile-head' | 'authority-transition' | 'fork-resolution' {
  return value === 'head'
    ? 'agent-profile-head'
    : value === 'transition'
      ? 'authority-transition'
      : 'fork-resolution';
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('system-record-schema', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('system-record-schema', `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    fail('system-record-schema', `${label} must not contain symbols`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('system-record-schema', `${label} must contain only enumerable data properties`);
    }
    if (descriptor.value === null) fail('system-record-schema', `${label} must omit optional fields, not use null`);
    result[key] = descriptor.value;
  }
  return result;
}

function assertNetwork(value: unknown): asserts value is NetworkIdV1 {
  try {
    assertNetworkIdV1(value);
  } catch (cause) {
    fail('system-record-scalar', 'networkId is invalid', cause);
  }
}

export function assertCanonicalSystemRecordPeerIdV1(value: unknown): asserts value is string {
  if (typeof value !== 'string' || UTF8.encode(value).byteLength > SYSTEM_RECORD_MAX_PEER_ID_BYTES) {
    fail('system-record-scalar', 'peerId is outside its byte bound');
  }
  try {
    if (peerIdFromString(value).toString() !== value) throw new Error('noncanonical');
  } catch (cause) {
    fail('system-record-scalar', 'peerId is not canonical', cause);
  }
}

function address(value: unknown, label: string): asserts value is EvmAddressV1 {
  try { assertCanonicalEvmAddress(value, label); } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

function digest(value: unknown, label: string): asserts value is Digest32V1 {
  try { assertCanonicalDigest(value, label); } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

function u64(value: unknown, label: string): bigint {
  try { return parseCanonicalDecimalU64(value, label); } catch (cause) {
    fail('system-record-scalar', `${label} is invalid`, cause);
  }
}

function digestArray(
  value: unknown,
  label: string,
  min: number,
  max: number,
): asserts value is readonly Digest32V1[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail('system-record-limit', `${label} must contain ${min}-${max} digests`);
  }
  for (let index = 0; index < value.length; index += 1) {
    digest(value[index], `${label}[${index}]`);
    if (index > 0 && value[index - 1] >= value[index]) {
      fail('system-record-order', `${label} must be sorted and duplicate-free`);
    }
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function bytesToBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(value).toString('hex')}`);
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function fail(
  code: SystemRecordObjectErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new SystemRecordObjectErrorV1(code, message, cause === undefined ? {} : { cause });
}
