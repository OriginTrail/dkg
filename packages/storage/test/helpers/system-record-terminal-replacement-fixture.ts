import { readFileSync } from 'node:fs';

import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileTombstoneHeadObjectV1,
  type Digest32V1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type { SystemRecordLaneExecutionBindingV1 } from '../../src/system-record-materializer-v1.js';
import type {
  SystemRecordActiveReplacementIssueV1,
  SystemRecordQuarantineReplacementIssueV1,
  SystemRecordTombstoneReplacementIssueV1,
} from '../../src/system-record-verified-replacement-v1-internal.js';
import {
  makeAuthenticActiveReplacementFixtureV1,
  makeSystemRecordActiveReplacementIssueV1,
} from './system-record-active-replacement-fixture.js';

interface Vectors {
  readonly signed: { readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 } };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;

export interface AuthenticTerminalReplacementFixtureV1 {
  readonly binding: SystemRecordLaneExecutionBindingV1;
  readonly epochQuad: ReturnType<typeof makeAuthenticActiveReplacementFixtureV1>['epochQuad'];
  readonly active: SystemRecordActiveReplacementIssueV1;
  readonly tombstone: SystemRecordTombstoneReplacementIssueV1;
  readonly quarantine: SystemRecordQuarantineReplacementIssueV1;
}

export async function makeAuthenticTerminalReplacementFixtureV1(
  mode: 'shadow' | 'authoritative' = 'authoritative',
): Promise<AuthenticTerminalReplacementFixtureV1> {
  const activeFixture = makeAuthenticActiveReplacementFixtureV1(mode);
  const binding = activeFixture.binding;
  const active = makeSystemRecordActiveReplacementIssueV1(binding);
  const predecessorDigest = computeAgentProfileHeadObjectDigestV1(active.head);
  const tombstoneHead: AgentProfileTombstoneHeadObjectV1 = Object.freeze({
    objectType: 'agent-profile-head',
    kind: 'agents',
    state: 'tombstone',
    networkId: active.head.networkId,
    peerId: active.head.peerId,
    peerPublicKey: active.head.peerPublicKey,
    authoritySequence: active.head.authoritySequence,
    version: String(BigInt(active.head.version) + 1n),
    previousHeadDigest: predecessorDigest,
    ...(active.head.acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest: active.head.acceptedTransitionDigest,
    }),
    evmIssuer: active.head.evmIssuer,
    rootSubject: active.head.rootSubject,
    projectionSchemaDigest: active.head.projectionSchemaDigest,
    issuedAt: '2026-08-05T12:11:00Z',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
  });
  const tombstoneDigest = computeAgentProfileHeadObjectDigestV1(tombstoneHead);
  const activeEnvelope: SignedAgentProfileHeadEnvelopeV1 = {
    ...structuredClone(vectors.signed.activeEip191.envelope),
    object: active.head,
    objectDigest: predecessorDigest,
  };
  const tombstoneEnvelope: SignedAgentProfileHeadEnvelopeV1 = {
    ...structuredClone(vectors.signed.activeEip191.envelope),
    object: tombstoneHead,
    objectDigest: tombstoneDigest,
  };
  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(
    active.head.rootSubject,
    active.ownedSubjectTable,
  );
  const artifacts = new Map([
    [`agent-profile-head:${predecessorDigest}`, {
      objectKind: 'agent-profile-head' as const,
      digest: predecessorDigest,
      canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(activeEnvelope),
    }],
    [`agent-profile-head:${tombstoneDigest}`, {
      objectKind: 'agent-profile-head' as const,
      digest: tombstoneDigest,
      canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(tombstoneEnvelope),
    }],
    [`owned-subject-table:${active.head.ownedSubjectTableDigest}`, {
      objectKind: 'owned-subject-table' as const,
      digest: active.head.ownedSubjectTableDigest,
      canonicalBytes: tableBytes,
    }],
  ]);
  const closure = await buildAgentProfileVerificationClosureV1(tombstoneDigest, {
    nowMs: Date.parse('2026-08-05T12:12:00Z'),
    resolve: async (reference) => artifacts.get(`${reference.objectKind}:${reference.digest}`),
    verifyAuthorityEnvelope: () => true,
    verifyCurrentBundle: () => {
      throw new Error('tombstone closure must not request a predecessor projection');
    },
  });

  const alternateDigest = `0x${'de'.repeat(32)}` as Digest32V1;
  const evidence: AgentProfileConflictEvidenceV1 = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: active.head.networkId,
    peerId: active.head.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'fork',
      authoritySequence: active.head.authoritySequence,
      version: active.head.version,
      objectDigests: Object.freeze([
        predecessorDigest,
        alternateDigest,
      ].sort()) as readonly Digest32V1[],
    })]),
  });
  const canonicalConflictEvidenceBytes = canonicalizeAgentProfileConflictEvidenceV1(evidence);
  const conflictEvidenceDigest = computeAgentProfileConflictEvidenceDigestV1(evidence);

  return Object.freeze({
    binding,
    epochQuad: activeFixture.epochQuad,
    active,
    tombstone: Object.freeze({
      ...binding,
      admittedDeadlineMs: active.admittedDeadlineMs,
      head: tombstoneHead,
      verifiedAuthoritySummary: closure.authoritySummary,
      deletionOwnedSubjectTable: active.ownedSubjectTable,
    }),
    quarantine: Object.freeze({
      ...active,
      conflictEvidenceDigest,
      canonicalConflictEvidenceBytes,
      terminalTransitionConflict: false,
    }),
  });
}
