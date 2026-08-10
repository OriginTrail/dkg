import {
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';
import type { Digest32V1 } from './sync-wire-scalars.js';

import type {
  AgentProfileAuthorityTransitionV1,
  AgentProfileForkResolutionV1,
  SignedAgentProfileAuthorityTransitionEnvelopeV1,
  SignedAgentProfileForkResolutionEnvelopeV1,
  SignedAgentProfileHeadEnvelopeV1,
} from './system-record-agent-profile-control-codecs-v1-internal.js';
import type {
  AgentProfileActiveHeadObjectV1,
  AgentProfileHeadObjectV1,
} from './system-record-agent-profile-head-codec-v1-internal.js';
import { digest } from './system-record-agent-profile-primitives-v1-internal.js';
import {
  computeOwnedSubjectTableDigestV1,
  parseCanonicalOwnedSubjectTableObjectV1,
} from './system-record-owned-subject-codecs-v1-internal.js';
import {
  isIssuedTooFarInFuture,
} from './system-record-authority-verification-v1-internal.js';
import {
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signed-envelope-codecs-v1-internal.js';

export type ClosureVisitPurposeV1 =
  | 'current'
  | 'history'
  | 'fork-evidence'
  | 'tombstone-predecessor'
  | 'deletion-predecessor';

export interface ClosureVisitReferenceV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly digest: Digest32V1;
  readonly purpose: ClosureVisitPurposeV1;
  readonly rootSubject?: string;
}

interface ClosureVisitBaseEffectsV1 {
  readonly references: readonly ClosureVisitReferenceV1[];
  readonly rootClaims: readonly string[];
}

export type ClosureVisitEffectsV1 =
  | Readonly<ClosureVisitBaseEffectsV1 & {
    objectKind: 'agent-profile-head';
    head: Readonly<{ digest: Digest32V1; object: AgentProfileHeadObjectV1 }>;
  }>
  | Readonly<ClosureVisitBaseEffectsV1 & {
    objectKind: 'authority-transition';
    transition: Readonly<{
      digest: Digest32V1;
      object: AgentProfileAuthorityTransitionV1;
    }>;
  }>
  | Readonly<ClosureVisitBaseEffectsV1 & {
    objectKind: 'fork-resolution';
    resolution: AgentProfileForkResolutionV1;
  }>
  | Readonly<ClosureVisitBaseEffectsV1 & {
    objectKind: 'profile-bundle' | 'owned-subject-table';
  }>;

export interface ClosureVisitContextV1 extends ClosureVisitReferenceV1 {}

export interface ClosureVisitFactsV1 {
  readonly currentHeadDigest: Digest32V1;
  readonly currentHead?: AgentProfileHeadObjectV1;
}

interface ClosureVisitExecutionBaseV1 {
  readonly nowMs: number;
  readonly verifyAuthorityEnvelope: (
    envelope:
      | SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1,
  ) => boolean | Promise<boolean>;
}

export interface ClosureCurrentBundleVerifierV1 {
  readonly verifyCurrentBundle: (
    head: AgentProfileActiveHeadObjectV1,
    canonicalBundleBytes: Uint8Array,
  ) => boolean | Promise<boolean>;
}

export type ClosureVisitExecutionV1 = Readonly<ClosureVisitExecutionBaseV1>;

export async function interpretClosureObjectV1(
  facts: ClosureVisitFactsV1,
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
  execution: ClosureVisitExecutionV1,
  currentBundleVerifier?: ClosureCurrentBundleVerifierV1,
): Promise<ClosureVisitEffectsV1> {
  switch (context.objectKind) {
    case 'agent-profile-head':
      return visitClosureHeadV1(facts, context, canonicalBytes, execution);
    case 'authority-transition':
      return visitClosureTransitionV1(context, canonicalBytes, execution);
    case 'fork-resolution':
      return visitClosureResolutionV1(context, canonicalBytes, execution);
    case 'profile-bundle':
      return visitClosureBundleV1(facts, context, canonicalBytes, currentBundleVerifier);
    case 'owned-subject-table':
      return visitClosureSubjectTableV1(context, canonicalBytes);
    default:
      fail(
        'system-record-closure',
        `${context.objectKind} is not part of an advertised row closure`,
      );
  }
}

async function visitClosureHeadV1(
  facts: ClosureVisitFactsV1,
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
  execution: ClosureVisitExecutionV1,
): Promise<ClosureVisitEffectsV1> {
  const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(canonicalBytes);
  if (
    envelope.objectDigest !== context.digest ||
    (await execution.verifyAuthorityEnvelope(envelope)) !== true
  ) {
    fail('system-record-closure', 'head authority verification failed');
  }
  const head = envelope.object;
  if (isIssuedTooFarInFuture(head.issuedAt, execution.nowMs)) {
    fail('system-record-closure', 'head issuedAt exceeds the future clock-skew bound');
  }
  const references: ClosureVisitReferenceV1[] = [];
  if (head.acceptedTransitionDigest !== undefined) {
    references.push(closureReference(
      'authority-transition', head.acceptedTransitionDigest, 'history',
    ));
  }
  if (context.digest === facts.currentHeadDigest && head.forkResolutionDigest !== undefined) {
    references.push(closureReference(
      'fork-resolution', head.forkResolutionDigest, 'history',
    ));
  }
  if (context.purpose === 'current' && head.state === 'active') {
    references.push(closureReference('profile-bundle', head.bundleDigest, 'current'));
  }
  if (head.state === 'tombstone') {
    references.push(closureReference(
      'agent-profile-head',
      head.previousHeadDigest,
      context.purpose === 'current' ? 'deletion-predecessor' : 'tombstone-predecessor',
    ));
  }
  if (
    context.purpose === 'deletion-predecessor' ||
    context.purpose === 'tombstone-predecessor'
  ) {
    if (head.state !== 'active') {
      fail('system-record-closure', 'tombstone predecessor must be active');
    }
    if (context.purpose === 'deletion-predecessor') {
      references.push(closureReference(
        'owned-subject-table', head.ownedSubjectTableDigest, 'history', head.rootSubject,
      ));
    }
  }
  return Object.freeze({
    objectKind: 'agent-profile-head',
    references: Object.freeze(references),
    head: Object.freeze({ digest: context.digest, object: head }),
    rootClaims: Object.freeze([head.rootSubject]),
  });
}

async function visitClosureTransitionV1(
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
  execution: ClosureVisitExecutionV1,
): Promise<ClosureVisitEffectsV1> {
  const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(canonicalBytes);
  if (
    envelope.objectDigest !== context.digest ||
    (await execution.verifyAuthorityEnvelope(envelope)) !== true
  ) {
    fail('system-record-closure', 'authority-transition verification failed');
  }
  return Object.freeze({
    objectKind: 'authority-transition',
    references: Object.freeze([
      closureReference('agent-profile-head', envelope.object.priorHeadDigest, 'history'),
    ]),
    transition: Object.freeze({ digest: context.digest, object: envelope.object }),
    rootClaims: Object.freeze([envelope.object.nextRoot]),
  });
}

async function visitClosureResolutionV1(
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
  execution: ClosureVisitExecutionV1,
): Promise<ClosureVisitEffectsV1> {
  const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(canonicalBytes);
  if (
    envelope.objectDigest !== context.digest ||
    (await execution.verifyAuthorityEnvelope(envelope)) !== true
  ) {
    fail('system-record-closure', 'fork-resolution verification failed');
  }
  if (isIssuedTooFarInFuture(envelope.object.issuedAt, execution.nowMs)) {
    fail('system-record-closure', 'fork resolution issuedAt exceeds the future clock-skew bound');
  }
  const references = envelope.object.evidenceHeadDigests.map((headDigest) =>
    closureReference('agent-profile-head', headDigest, 'fork-evidence'));
  if (envelope.object.forkBaseHeadDigest !== undefined) {
    references.push(closureReference(
      'agent-profile-head', envelope.object.forkBaseHeadDigest, 'history',
    ));
  }
  return Object.freeze({
    objectKind: 'fork-resolution',
    references: Object.freeze(references),
    resolution: envelope.object,
    rootClaims: Object.freeze([]),
  });
}

async function visitClosureBundleV1(
  facts: ClosureVisitFactsV1,
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
  currentBundleVerifier: ClosureCurrentBundleVerifierV1 | undefined,
): Promise<ClosureVisitEffectsV1> {
  if (currentBundleVerifier === undefined) {
    fail('system-record-closure', 'profile bundle visit requires a materialization verifier');
  }
  const current = facts.currentHead;
  if (
    current?.state !== 'active' ||
    digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, canonicalBytes) !==
      context.digest ||
    (await currentBundleVerifier.verifyCurrentBundle(current, canonicalBytes.slice())) !== true
  ) {
    fail('system-record-closure', 'current profile bundle verification failed');
  }
  return emptyClosureVisitEffectsV1('profile-bundle');
}

function visitClosureSubjectTableV1(
  context: ClosureVisitContextV1,
  canonicalBytes: Uint8Array,
): ClosureVisitEffectsV1 {
  if (context.rootSubject === undefined) {
    fail('system-record-closure', 'subject table lacks root context');
  }
  const table = parseCanonicalOwnedSubjectTableObjectV1(context.rootSubject, canonicalBytes);
  if (computeOwnedSubjectTableDigestV1(context.rootSubject, table) !== context.digest) {
    fail('system-record-closure', 'owned-subject table digest mismatch');
  }
  return emptyClosureVisitEffectsV1('owned-subject-table');
}

function closureReference(
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
  purpose: ClosureVisitPurposeV1,
  rootSubject?: string,
): ClosureVisitReferenceV1 {
  digest(objectDigest, 'closure reference digest');
  return Object.freeze({
    objectKind,
    digest: objectDigest,
    purpose,
    ...(rootSubject === undefined ? {} : { rootSubject }),
  });
}

function emptyClosureVisitEffectsV1(
  objectKind: 'profile-bundle' | 'owned-subject-table',
): ClosureVisitEffectsV1 {
  return Object.freeze({
    objectKind,
    references: Object.freeze([]),
    rootClaims: Object.freeze([]),
  });
}
