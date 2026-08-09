import {
  canonicalizeJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from './canonical-json.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  assertAgentRootV1,
  assertSystemRecordNetworkV1,
  digest,
  digestArray,
  digestSystemRecordBytesV1,
  snapshotSystemRecordDataRecord,
  u64,
} from './system-record-agent-profile-primitives-v1-internal.js';
import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_CONFLICT_ENTRIES,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
} from './system-record-limits-v1.js';
import { type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotDataArray, snapshotExactDataRecord } from './sync-wire-objects.js';
import { type DecimalU64V1, type Digest32V1 } from './sync-wire-scalars.js';

const REQUEST_RECORD_KIND = SYSTEM_RECORD_KIND_V1;

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
  assertSystemRecordNetworkV1(evidence.networkId);
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
  assertSystemRecordNetworkV1(evidence.networkId);
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
