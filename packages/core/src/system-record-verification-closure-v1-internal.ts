import { snapshotExactDataRecord } from './sync-wire-objects.js';
import { parseCanonicalDecimalU64, type Digest32V1 } from './sync-wire-scalars.js';
import {
  copyBoundedSystemRecordBytesV1,
  digestSystemRecordBytesV1,
  failSystemRecordObjectV1 as fail,
} from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_CONFLICT_DIGESTS,
  SYSTEM_RECORD_MAX_RESOLVED_FORK_TUPLES,
  SYSTEM_RECORD_MAX_ROOT_CLAIMS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type SystemRecordObjectKindV1,
} from './system-record-limits-v1.js';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeOwnedSubjectTableDigestV1,
  digest,
  parseCanonicalOwnedSubjectTableObjectV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from './system-record-agent-profile-codecs-v1-internal.js';
import {
  mintAgentProfileVerifiedAuthoritySummaryV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
} from './system-record-authority-summary-v1-internal.js';
import type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';
import {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  isIssuedTooFarInFuture,
  isSafeNow,
  isTombstoneBoundToPredecessorV1,
} from './system-record-authority-v1-internal.js';
import {
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signatures-v1-internal.js';

export interface SystemRecordVerificationClosureObjectV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly digest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
  readonly references: readonly Pick<
    SystemRecordVerificationClosureObjectV1,
    'objectKind' | 'digest'
  >[];
}

export interface SystemRecordVerificationClosureV1 {
  readonly objects: readonly SystemRecordVerificationClosureObjectV1[];
  readonly canonicalBytes: number;
  readonly rootClaims: number;
  readonly resolvedForkTuples: number;
  readonly authoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
}

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
    envelope:
      | SignedAgentProfileHeadEnvelopeV1
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
  const nowMs = verifier.nowMs;
  const resolve = verifier.resolve;
  const verifyAuthorityEnvelope = verifier.verifyAuthorityEnvelope;
  const verifyCurrentBundle = verifier.verifyCurrentBundle;
  if (!isSafeNow(nowMs)) fail('system-record-closure', 'closure verifier clock is invalid');
  if (
    typeof resolve !== 'function' ||
    typeof verifyAuthorityEnvelope !== 'function' ||
    typeof verifyCurrentBundle !== 'function'
  ) {
    fail('system-record-closure', 'closure verifier callbacks are invalid');
  }
  const pending = new Map<
    string,
    {
      objectKind: SystemRecordObjectKindV1;
      digest: Digest32V1;
      purpose: ClosurePurposeV1;
      rootSubject?: string;
      referencedByHeadDigest?: Digest32V1;
    }
  >();
  const artifacts: SystemRecordVerificationClosureObjectV1[] = [];
  const parsedHeads = new Map<Digest32V1, AgentProfileHeadObjectV1>();
  const parsedTransitions = new Map<Digest32V1, AgentProfileAuthorityTransitionV1>();
  const parsedResolutions: AgentProfileForkResolutionV1[] = [];
  const seen = new Map<Digest32V1, SystemRecordObjectKindV1>();
  const rootClaims = new Set<string>();
  let bytes = 0;
  enqueue('agent-profile-head', currentHeadDigest, 'current');

  while (pending.size > 0) {
    const context = Object.freeze({
      ...[...pending.values()].sort(compareClosureObjects)[0],
    });
    const key = context.digest;
    pending.delete(key);
    const seenKind = seen.get(key);
    if (seenKind !== undefined) {
      if (seenKind !== context.objectKind) {
        fail(
          'system-record-closure',
          'one closure digest was presented under different object kinds',
        );
      }
      continue;
    }
    const resolved = await resolve(
      Object.freeze({
        objectKind: context.objectKind,
        digest: context.digest,
      }),
    );
    if (resolved === undefined)
      fail('system-record-closure', `verification closure is missing ${key}`);
    const artifact = snapshotExactDataRecord(
      resolved,
      ['objectKind', 'digest', 'canonicalBytes'],
      'verification closure artifact',
    );
    if (artifact.objectKind !== context.objectKind || artifact.digest !== context.digest) {
      fail('system-record-closure', 'closure resolver returned a different artifact');
    }
    const objectKind = context.objectKind;
    const objectDigest = context.digest;
    let canonicalBytes: Uint8Array;
    try {
      canonicalBytes = copyBoundedSystemRecordBytesV1(
        artifact.canonicalBytes,
        SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind],
        'closure artifact canonical bytes',
      );
    } catch (cause) {
      fail('system-record-closure', 'closure artifact exceeds its kind cap', cause);
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
      references.push(Object.freeze({ objectKind, digest: objectDigest }));
    };

    if (objectKind === 'agent-profile-head') {
      const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(canonicalBytes);
      if (
        envelope.objectDigest !== objectDigest ||
        (await verifyAuthorityEnvelope(envelope)) !== true
      ) {
        fail('system-record-closure', 'head authority verification failed');
      }
      const head = envelope.object;
      if (isIssuedTooFarInFuture(head.issuedAt, nowMs)) {
        fail('system-record-closure', 'head issuedAt exceeds the future clock-skew bound');
      }
      parsedHeads.set(objectDigest, head);
      rootClaims.add(head.rootSubject);
      if (head.acceptedTransitionDigest !== undefined) {
        add(
          'authority-transition',
          head.acceptedTransitionDigest,
          'history',
          undefined,
          objectDigest,
        );
      }
      if (objectDigest === currentHeadDigest && head.forkResolutionDigest !== undefined) {
        add('fork-resolution', head.forkResolutionDigest, 'history', undefined, objectDigest);
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
      if (
        context.purpose === 'deletion-predecessor' ||
        context.purpose === 'tombstone-predecessor'
      ) {
        if (head.state !== 'active')
          fail('system-record-closure', 'tombstone predecessor must be active');
        if (context.purpose === 'deletion-predecessor') {
          add('owned-subject-table', head.ownedSubjectTableDigest, 'history', head.rootSubject);
        }
      }
    } else if (objectKind === 'authority-transition') {
      const envelope =
        parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(canonicalBytes);
      if (
        envelope.objectDigest !== objectDigest ||
        (await verifyAuthorityEnvelope(envelope)) !== true
      ) {
        fail('system-record-closure', 'authority-transition verification failed');
      }
      parsedTransitions.set(objectDigest, envelope.object);
      if (context.referencedByHeadDigest !== undefined) {
        const referencingHead = parsedHeads.get(context.referencedByHeadDigest);
        if (
          referencingHead === undefined ||
          !isAgentProfileHeadBoundToAcceptedTransitionV1(referencingHead, envelope.object)
        ) {
          fail('system-record-closure', 'head does not bind its accepted authority transition');
        }
      }
      rootClaims.add(envelope.object.nextRoot);
      add('agent-profile-head', envelope.object.priorHeadDigest, 'history');
    } else if (objectKind === 'fork-resolution') {
      const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(canonicalBytes);
      if (
        envelope.objectDigest !== objectDigest ||
        (await verifyAuthorityEnvelope(envelope)) !== true
      ) {
        fail('system-record-closure', 'fork-resolution verification failed');
      }
      parsedResolutions.push(envelope.object);
      if (isIssuedTooFarInFuture(envelope.object.issuedAt, nowMs)) {
        fail(
          'system-record-closure',
          'fork resolution issuedAt exceeds the future clock-skew bound',
        );
      }
      if (context.referencedByHeadDigest !== undefined) {
        const referencingHead = parsedHeads.get(context.referencedByHeadDigest);
        if (
          referencingHead === undefined ||
          !isDirectResolvingSuccessorV1(referencingHead, envelope.object)
        ) {
          fail(
            'system-record-closure',
            'current head is not the direct successor of its fork resolution',
          );
        }
      }
      for (const headDigest of envelope.object.evidenceHeadDigests) {
        add('agent-profile-head', headDigest, 'fork-evidence');
      }
      if (envelope.object.forkBaseHeadDigest !== undefined) {
        add('agent-profile-head', envelope.object.forkBaseHeadDigest, 'history');
      }
    } else if (objectKind === 'profile-bundle') {
      const current = parsedHeads.get(currentHeadDigest);
      if (
        current?.state !== 'active' ||
        digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, canonicalBytes) !==
          objectDigest ||
        (await verifyCurrentBundle(current, canonicalBytes.slice())) !== true
      ) {
        fail('system-record-closure', 'current profile bundle verification failed');
      }
    } else if (objectKind === 'owned-subject-table') {
      if (context.rootSubject === undefined)
        fail('system-record-closure', 'subject table lacks root context');
      const table = parseCanonicalOwnedSubjectTableObjectV1(context.rootSubject, canonicalBytes);
      if (computeOwnedSubjectTableDigestV1(context.rootSubject, table) !== objectDigest) {
        fail('system-record-closure', 'owned-subject table digest mismatch');
      }
    } else {
      fail('system-record-closure', `${objectKind} is not part of an advertised row closure`);
    }

    bytes += canonicalBytes.byteLength;
    if (
      artifacts.length + 1 > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS ||
      bytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES ||
      rootClaims.size > SYSTEM_RECORD_MAX_ROOT_CLAIMS ||
      parsedResolutions.length > SYSTEM_RECORD_MAX_RESOLVED_FORK_TUPLES
    ) {
      fail('system-record-closure', 'verification closure exceeds a V1 bound');
    }
    seen.set(key, objectKind);
    artifacts.push(
      Object.freeze({
        objectKind,
        digest: objectDigest,
        canonicalBytes,
        references: Object.freeze(references.sort(compareClosureObjects)),
      }),
    );
    if (seen.size + pending.size > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
      fail('system-record-closure', 'verification closure cannot fit before dependency fetch');
    }
  }

  for (const resolution of parsedResolutions) {
    const evidence = resolution.evidenceHeadDigests.map((headDigest) =>
      parsedHeads.get(headDigest),
    );
    if (evidence.some((head) => head === undefined)) {
      fail('system-record-closure', 'fork evidence is incomplete after traversal');
    }
    const base =
      resolution.forkBaseHeadDigest === undefined
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
      if (
        head.forkResolutionDigest === resolutionDigest &&
        head.acceptedTransitionDigest !== transitionDigest
      ) {
        fail('system-record-closure', 'resolving successor changed accepted-transition lineage');
      }
    }
  }
  const transitionTupleDigests = new Map<string, Digest32V1>();
  for (const [transitionDigest, transition] of parsedTransitions) {
    const prior = parsedHeads.get(transition.priorHeadDigest);
    if (
      prior === undefined ||
      evaluateAuthorityTransitionV1(transition, prior, nowMs).decision !== 'accept'
    ) {
      fail(
        'system-record-closure',
        `authority transition ${transitionDigest} lacks its exact accepted predecessor`,
      );
    }
    const tuple = [
      transition.networkId,
      transition.peerId,
      transition.priorAuthoritySequence,
      transition.nextAuthoritySequence,
    ].join('\u0000');
    const priorDigest = transitionTupleDigests.get(tuple);
    if (priorDigest !== undefined && priorDigest !== transitionDigest) {
      fail(
        'system-record-closure',
        'verification closure contains authority-transition equivocation',
      );
    }
    transitionTupleDigests.set(tuple, transitionDigest);
  }
  for (const [headDigest, head] of parsedHeads) {
    assertCompleteUniqueRootLineage(headDigest, head);
    if (head.acceptedTransitionDigest !== undefined) {
      const transition = parsedTransitions.get(head.acceptedTransitionDigest);
      if (
        transition === undefined ||
        !isAgentProfileHeadBoundToAcceptedTransitionV1(head, transition)
      ) {
        fail('system-record-closure', `head ${headDigest} does not bind its accepted transition`);
      }
    }
    if (headDigest === currentHeadDigest && head.forkResolutionDigest !== undefined) {
      const resolution = parsedResolutions.find(
        (candidate) =>
          computeAgentProfileForkResolutionDigestV1(candidate) === head.forkResolutionDigest,
      );
      if (resolution === undefined || !isDirectResolvingSuccessorV1(head, resolution)) {
        fail(
          'system-record-closure',
          `head ${headDigest} does not directly bind its fork resolution`,
        );
      }
    }
  }
  for (const head of parsedHeads.values()) {
    if (head.state === 'tombstone') {
      const predecessor = parsedHeads.get(head.previousHeadDigest);
      if (predecessor?.state !== 'active' || !isTombstoneBoundToPredecessorV1(head, predecessor)) {
        fail(
          'system-record-closure',
          'tombstone predecessor is not the exact prior active authority state',
        );
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
        fail(
          'system-record-closure',
          'one closure digest was referenced under different object kinds',
        );
      }
      return;
    }
    const existing = pending.get(key);
    if (existing !== undefined && existing.objectKind !== objectKind) {
      fail('system-record-closure', 'one pending closure digest has conflicting object kinds');
    }
    const priority: Record<ClosurePurposeV1, number> = {
      history: 0,
      'fork-evidence': 1,
      'tombstone-predecessor': 2,
      'deletion-predecessor': 3,
      current: 4,
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
      if (
        depth >= Number(SYSTEM_RECORD_AUTHORITY_SEQUENCE_MAX) ||
        cursor.acceptedTransitionDigest === undefined
      ) {
        fail('system-record-history', `head ${headDigest} has incomplete authority/root lineage`);
      }
      const transition = parsedTransitions.get(cursor.acceptedTransitionDigest);
      const prior =
        transition === undefined ? undefined : parsedHeads.get(transition.priorHeadDigest);
      if (
        transition === undefined ||
        prior === undefined ||
        parseCanonicalDecimalU64(transition.nextAuthoritySequence) !== sequence ||
        parseCanonicalDecimalU64(prior.authoritySequence) + 1n !== sequence
      ) {
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
      fail(
        'system-record-history',
        `head ${headDigest} has authority evidence below sequence zero`,
      );
    }
  }

  function createVerifiedAuthoritySummary(): AgentProfileVerifiedAuthoritySummaryV1 {
    const current = parsedHeads.get(currentHeadDigest);
    if (current === undefined)
      fail('system-record-closure', 'verified closure lost its current head');
    const reverseLineage: AgentProfileAppliedTransitionV1[] = [];
    const reverseRoots: string[] = [];
    let cursor = current;
    let sequence = parseCanonicalDecimalU64(current.authoritySequence);
    while (sequence > 0n) {
      const transition =
        cursor.acceptedTransitionDigest === undefined
          ? undefined
          : parsedTransitions.get(cursor.acceptedTransitionDigest);
      const prior =
        transition === undefined ? undefined : parsedHeads.get(transition.priorHeadDigest);
      if (transition === undefined || prior === undefined) {
        fail('system-record-history', 'verified closure lost its authority lineage');
      }
      reverseLineage.push(
        Object.freeze({
          priorAuthoritySequence: transition.priorAuthoritySequence,
          nextAuthoritySequence: transition.nextAuthoritySequence,
          transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
        }),
      );
      reverseRoots.push(prior.rootSubject);
      cursor = prior;
      sequence -= 1n;
    }
    const tombstonePredecessor =
      current.state === 'tombstone' ? parsedHeads.get(current.previousHeadDigest) : undefined;
    if (tombstonePredecessor !== undefined && tombstonePredecessor.state !== 'active') {
      fail('system-record-history', 'verified tombstone closure lost its active predecessor');
    }
    const latestTransition =
      current.acceptedTransitionDigest === undefined
        ? undefined
        : parsedTransitions.get(current.acceptedTransitionDigest);
    if (current.authoritySequence !== '0' && latestTransition === undefined) {
      fail('system-record-history', 'verified closure lost its latest authority transition');
    }
    return mintAgentProfileVerifiedAuthoritySummaryV1({
      candidateHeadDigest: currentHeadDigest,
      transitionLineage: Object.freeze(reverseLineage.reverse()),
      historicalRoots: Object.freeze(reverseRoots.reverse()),
      lastAuthorityTransitionPriorHeadDigest: latestTransition?.priorHeadDigest,
      tombstonePredecessor:
        tombstonePredecessor?.state === 'active' ? tombstonePredecessor : undefined,
      deletionTableDigest: tombstonePredecessor?.ownedSubjectTableDigest,
    });
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
  let objects =
    mode === 'active'
      ? 2 + Number(authoritySequence) * 2
      : mode === 'tombstone'
        ? 3 + Number(authoritySequence) * 2
        : 4 + Number(authoritySequence) * 2 + conflictHeads;
  if (
    mode === 'fork' &&
    (conflictHeads < 2 || conflictHeads > SYSTEM_RECORD_MAX_CONFLICT_DIGESTS)
  ) {
    fail('system-record-closure', 'fork closure needs 2-16 evidence heads');
  }
  if (objects > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
    fail('system-record-closure', `closure requires ${objects} objects, over the V1 cap`);
  }
  return objects;
}
