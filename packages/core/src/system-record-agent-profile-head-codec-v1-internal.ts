import { assertAssertionCoordinateV1, type AssertionCoordinateV1 } from './author-catalog-codec.js';
import {
  assertCanonicalGraphScopedAuthorSealV1,
  type CanonicalGraphScopedAuthorSealV1,
} from './canonical-graph-scoped-author-seal.js';
import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import { parseDeterministicKnowledgeAssetUal } from './ka-content-scope.js';
import { type NetworkIdV1 } from './sync-wire-identifiers.js';
import { hasOwnDataProperty, snapshotDataRecord, snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  assertAgentRootV1,
  assertCanonicalRfc3339SecondsV1,
  assertSystemRecordAddressV1,
  assertSystemRecordNetworkV1,
  assertSystemRecordPeerBindingV1,
  digest,
  digestSystemRecordBytesV1,
  numericChainIdForNetworkV1,
  snapshotSystemRecordDataRecord,
  u64,
  type CanonicalRfc3339SecondsV1,
  type SystemRecordPeerPublicKeyV1,
} from './system-record-agent-profile-primitives-v1-internal.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import { EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 } from './system-record-owned-subject-codecs-v1-internal.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_JSON_DEPTH,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_BYTES,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';

const REQUEST_RECORD_KIND = SYSTEM_RECORD_KIND_V1;

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
  assertSystemRecordNetworkV1(head.networkId);
  assertSystemRecordPeerBindingV1(head.peerId, head.peerPublicKey);
  const authoritySequence = u64(head.authoritySequence, 'authoritySequence');
  const version = u64(head.version, 'version');
  if (authoritySequence > SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) {
    fail('system-record-limit', 'authoritySequence exceeds the V1 root-claim bound');
  }
  for (const key of optional) digest(head[key], key);
  assertSystemRecordAddressV1(head.evmIssuer, 'evmIssuer');
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
