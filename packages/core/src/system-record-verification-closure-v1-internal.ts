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
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
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
import type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';
import {
  assertAgentProfileForkResolutionEvidenceV1,
  evaluateAuthorityTransitionV1,
  isAgentProfileHeadBoundToAcceptedTransitionV1,
  isDirectResolvingSuccessorV1,
  isIssuedTooFarInFuture,
  isSafeNow,
  isTombstoneBoundToPredecessorV1,
} from './system-record-authority-verification-v1-internal.js';
import {
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
} from './system-record-signatures-v1-internal.js';

const MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1 = Symbol(
  'mint-agent-profile-verified-authority-summary-v1',
);
const MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1 = new WeakSet<object>();

class AgentProfileVerifiedAuthoritySummaryValueV1 {
  declare private readonly __opaqueAgentProfileVerifiedAuthoritySummaryV1: void;

  constructor(
    token: typeof MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1,
    public readonly candidateHeadDigest: Digest32V1,
    public readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[],
    public readonly historicalRoots: readonly string[],
    public readonly lastAuthorityTransitionPriorHeadDigest?: Digest32V1,
    public readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1,
    public readonly deletionTableDigest?: Digest32V1,
  ) {
    if (token !== MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1) {
      fail('system-record-closure', 'verified authority summary is factory-only');
    }
    MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1.add(this);
    Object.freeze(this);
  }
}

/** Process- and module-instance-local capability minted only by closure verification. */
export type AgentProfileVerifiedAuthoritySummaryV1 =
  AgentProfileVerifiedAuthoritySummaryValueV1;

export function assertAgentProfileVerifiedAuthoritySummaryV1(
  value: unknown,
): asserts value is AgentProfileVerifiedAuthoritySummaryV1 {
  if (!isAgentProfileVerifiedAuthoritySummaryV1(value)) {
    fail(
      'system-record-closure',
      'verified authority summary was not minted by closure verification',
    );
  }
}

export function isAgentProfileVerifiedAuthoritySummaryV1(
  value: unknown,
): value is AgentProfileVerifiedAuthoritySummaryV1 {
  return (
    value !== null &&
    typeof value === 'object' &&
    MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1.has(value) &&
    value instanceof AgentProfileVerifiedAuthoritySummaryValueV1
  );
}

function mintAgentProfileVerifiedAuthoritySummaryV1(
  input: Readonly<{
    candidateHeadDigest: Digest32V1;
    transitionLineage: readonly AgentProfileAppliedTransitionV1[];
    historicalRoots: readonly string[];
    lastAuthorityTransitionPriorHeadDigest?: Digest32V1;
    tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
    deletionTableDigest?: Digest32V1;
  }>,
): AgentProfileVerifiedAuthoritySummaryV1 {
  return new AgentProfileVerifiedAuthoritySummaryValueV1(
    MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1,
    input.candidateHeadDigest,
    input.transitionLineage,
    input.historicalRoots,
    input.lastAuthorityTransitionPriorHeadDigest,
    input.tombstonePredecessor,
    input.deletionTableDigest,
  );
}

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

interface ClosurePendingReferenceV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly digest: Digest32V1;
  readonly purpose: ClosurePurposeV1;
  readonly rootSubject?: string;
  readonly referencedByHeadDigest?: Digest32V1;
}

interface ClosureTraversalStateV1 {
  readonly currentHeadDigest: Digest32V1;
  readonly pending: Map<string, ClosurePendingReferenceV1>;
  readonly artifacts: SystemRecordVerificationClosureObjectV1[];
  readonly parsedHeads: Map<Digest32V1, AgentProfileHeadObjectV1>;
  readonly parsedTransitions: Map<Digest32V1, AgentProfileAuthorityTransitionV1>;
  readonly parsedResolutions: AgentProfileForkResolutionV1[];
  readonly seen: Map<Digest32V1, SystemRecordObjectKindV1>;
  readonly rootClaims: Set<string>;
  canonicalBytes: number;
}

interface CollectedClosureV1 {
  readonly currentHeadDigest: Digest32V1;
  readonly artifacts: readonly SystemRecordVerificationClosureObjectV1[];
  readonly parsedHeads: ReadonlyMap<Digest32V1, AgentProfileHeadObjectV1>;
  readonly parsedTransitions: ReadonlyMap<
    Digest32V1,
    AgentProfileAuthorityTransitionV1
  >;
  readonly parsedResolutions: readonly AgentProfileForkResolutionV1[];
  readonly rootClaimCount: number;
  readonly canonicalBytes: number;
}

interface ClosureExecutionV1 {
  readonly nowMs: number;
  readonly resolve: AgentProfileClosureVerifierV1['resolve'];
  readonly verifyAuthorityEnvelope: AgentProfileClosureVerifierV1['verifyAuthorityEnvelope'];
  readonly verifyCurrentBundle: AgentProfileClosureVerifierV1['verifyCurrentBundle'];
}

function createClosureTraversalStateV1(
  currentHeadDigest: Digest32V1,
): ClosureTraversalStateV1 {
  return {
    currentHeadDigest,
    pending: new Map(),
    artifacts: [],
    parsedHeads: new Map(),
    parsedTransitions: new Map(),
    parsedResolutions: [],
    seen: new Map(),
    rootClaims: new Set(),
    canonicalBytes: 0,
  };
}

const CLOSURE_PURPOSE_PRIORITY_V1: Readonly<Record<ClosurePurposeV1, number>> = Object.freeze({
  history: 0,
  'fork-evidence': 1,
  'tombstone-predecessor': 2,
  'deletion-predecessor': 3,
  current: 4,
});

function enqueueClosureReferenceV1(
  state: ClosureTraversalStateV1,
  objectKind: SystemRecordObjectKindV1,
  objectDigest: Digest32V1,
  purpose: ClosurePurposeV1,
  rootSubject?: string,
  referencedByHeadDigest?: Digest32V1,
): void {
  digest(objectDigest, 'closure reference digest');
  const seenKind = state.seen.get(objectDigest);
  if (seenKind !== undefined) {
    if (seenKind !== objectKind) {
      fail(
        'system-record-closure',
        'one closure digest was referenced under different object kinds',
      );
    }
    return;
  }
  const existing = state.pending.get(objectDigest);
  if (existing !== undefined && existing.objectKind !== objectKind) {
    fail('system-record-closure', 'one pending closure digest has conflicting object kinds');
  }
  if (
    existing === undefined ||
    CLOSURE_PURPOSE_PRIORITY_V1[purpose] > CLOSURE_PURPOSE_PRIORITY_V1[existing.purpose]
  ) {
    state.pending.set(objectDigest, {
      objectKind,
      digest: objectDigest,
      purpose,
      ...(rootSubject === undefined ? {} : { rootSubject }),
      ...(referencedByHeadDigest === undefined ? {} : { referencedByHeadDigest }),
    });
  }
}

type ClosureReferenceV1 = Pick<
  SystemRecordVerificationClosureObjectV1,
  'objectKind' | 'digest'
>;

async function visitClosureObjectV1(
  state: ClosureTraversalStateV1,
  context: ClosurePendingReferenceV1,
  canonicalBytes: Uint8Array,
  references: ClosureReferenceV1[],
  execution: ClosureExecutionV1,
): Promise<void> {
  const objectKind = context.objectKind;
  const objectDigest = context.digest;
  const add = (
    referencedKind: SystemRecordObjectKindV1,
    referencedDigest: Digest32V1,
    purpose: ClosurePurposeV1,
    rootSubject?: string,
    referencedByHeadDigest?: Digest32V1,
  ) => {
    enqueueClosureReferenceV1(
      state,
      referencedKind,
      referencedDigest,
      purpose,
      rootSubject,
      referencedByHeadDigest,
    );
    references.push(Object.freeze({ objectKind: referencedKind, digest: referencedDigest }));
  };

  if (objectKind === 'agent-profile-head') {
    const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(canonicalBytes);
    if (
      envelope.objectDigest !== objectDigest ||
      (await execution.verifyAuthorityEnvelope(envelope)) !== true
    ) {
      fail('system-record-closure', 'head authority verification failed');
    }
    const head = envelope.object;
    if (isIssuedTooFarInFuture(head.issuedAt, execution.nowMs)) {
      fail('system-record-closure', 'head issuedAt exceeds the future clock-skew bound');
    }
    state.parsedHeads.set(objectDigest, head);
    state.rootClaims.add(head.rootSubject);
    if (head.acceptedTransitionDigest !== undefined) {
      add(
        'authority-transition',
        head.acceptedTransitionDigest,
        'history',
        undefined,
        objectDigest,
      );
    }
    if (
      objectDigest === state.currentHeadDigest &&
      head.forkResolutionDigest !== undefined
    ) {
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
      if (head.state !== 'active') {
        fail('system-record-closure', 'tombstone predecessor must be active');
      }
      if (context.purpose === 'deletion-predecessor') {
        add('owned-subject-table', head.ownedSubjectTableDigest, 'history', head.rootSubject);
      }
    }
    return;
  }

  if (objectKind === 'authority-transition') {
    const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(canonicalBytes);
    if (
      envelope.objectDigest !== objectDigest ||
      (await execution.verifyAuthorityEnvelope(envelope)) !== true
    ) {
      fail('system-record-closure', 'authority-transition verification failed');
    }
    state.parsedTransitions.set(objectDigest, envelope.object);
    if (context.referencedByHeadDigest !== undefined) {
      const referencingHead = state.parsedHeads.get(context.referencedByHeadDigest);
      if (
        referencingHead === undefined ||
        !isAgentProfileHeadBoundToAcceptedTransitionV1(referencingHead, envelope.object)
      ) {
        fail('system-record-closure', 'head does not bind its accepted authority transition');
      }
    }
    state.rootClaims.add(envelope.object.nextRoot);
    add('agent-profile-head', envelope.object.priorHeadDigest, 'history');
    return;
  }

  if (objectKind === 'fork-resolution') {
    const envelope = parseCanonicalSignedAgentProfileForkResolutionEnvelopeV1(canonicalBytes);
    if (
      envelope.objectDigest !== objectDigest ||
      (await execution.verifyAuthorityEnvelope(envelope)) !== true
    ) {
      fail('system-record-closure', 'fork-resolution verification failed');
    }
    state.parsedResolutions.push(envelope.object);
    if (isIssuedTooFarInFuture(envelope.object.issuedAt, execution.nowMs)) {
      fail('system-record-closure', 'fork resolution issuedAt exceeds the future clock-skew bound');
    }
    if (context.referencedByHeadDigest !== undefined) {
      const referencingHead = state.parsedHeads.get(context.referencedByHeadDigest);
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
    return;
  }

  if (objectKind === 'profile-bundle') {
    const current = state.parsedHeads.get(state.currentHeadDigest);
    if (
      current?.state !== 'active' ||
      digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, canonicalBytes) !==
        objectDigest ||
      (await execution.verifyCurrentBundle(current, canonicalBytes.slice())) !== true
    ) {
      fail('system-record-closure', 'current profile bundle verification failed');
    }
    return;
  }

  if (objectKind === 'owned-subject-table') {
    if (context.rootSubject === undefined) {
      fail('system-record-closure', 'subject table lacks root context');
    }
    const table = parseCanonicalOwnedSubjectTableObjectV1(context.rootSubject, canonicalBytes);
    if (computeOwnedSubjectTableDigestV1(context.rootSubject, table) !== objectDigest) {
      fail('system-record-closure', 'owned-subject table digest mismatch');
    }
    return;
  }

  fail('system-record-closure', `${objectKind} is not part of an advertised row closure`);
}

async function collectVerificationClosureV1(
  currentHeadDigest: Digest32V1,
  execution: ClosureExecutionV1,
): Promise<CollectedClosureV1> {
  const state = createClosureTraversalStateV1(currentHeadDigest);
  enqueueClosureReferenceV1(
    state,
    'agent-profile-head',
    currentHeadDigest,
    'current',
  );

  while (state.pending.size > 0) {
    const context = Object.freeze({
      ...[...state.pending.values()].sort(compareClosureObjects)[0],
    });
    const key = context.digest;
    state.pending.delete(key);
    const seenKind = state.seen.get(key);
    if (seenKind !== undefined) {
      if (seenKind !== context.objectKind) {
        fail(
          'system-record-closure',
          'one closure digest was presented under different object kinds',
        );
      }
      continue;
    }
    const resolved = await execution.resolve(
      Object.freeze({
        objectKind: context.objectKind,
        digest: context.digest,
      }),
    );
    if (resolved === undefined) {
      fail('system-record-closure', `verification closure is missing ${key}`);
    }
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
    const references: ClosureReferenceV1[] = [];
    await visitClosureObjectV1(state, context, canonicalBytes, references, execution);

    state.canonicalBytes += canonicalBytes.byteLength;
    if (
      state.artifacts.length + 1 > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS ||
      state.canonicalBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES ||
      state.rootClaims.size > SYSTEM_RECORD_MAX_ROOT_CLAIMS ||
      state.parsedResolutions.length > SYSTEM_RECORD_MAX_RESOLVED_FORK_TUPLES
    ) {
      fail('system-record-closure', 'verification closure exceeds a V1 bound');
    }
    state.seen.set(key, objectKind);
    state.artifacts.push(
      Object.freeze({
        objectKind,
        digest: objectDigest,
        canonicalBytes,
        references: Object.freeze(references.sort(compareClosureObjects)),
      }),
    );
    if (state.seen.size + state.pending.size > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS) {
      fail('system-record-closure', 'verification closure cannot fit before dependency fetch');
    }
  }

  return Object.freeze({
    currentHeadDigest,
    artifacts: Object.freeze([...state.artifacts]),
    parsedHeads: new Map(state.parsedHeads),
    parsedTransitions: new Map(state.parsedTransitions),
    parsedResolutions: Object.freeze([...state.parsedResolutions]),
    rootClaimCount: state.rootClaims.size,
    canonicalBytes: state.canonicalBytes,
  });
}

function validateCollectedClosureAuthorityV1(
  state: CollectedClosureV1,
  nowMs: number,
): void {
  for (const resolution of state.parsedResolutions) {
    const evidence = resolution.evidenceHeadDigests.map((headDigest) =>
      state.parsedHeads.get(headDigest),
    );
    if (evidence.some((head) => head === undefined)) {
      fail('system-record-closure', 'fork evidence is incomplete after traversal');
    }
    const base = resolution.forkBaseHeadDigest === undefined
      ? undefined
      : state.parsedHeads.get(resolution.forkBaseHeadDigest);
    assertAgentProfileForkResolutionEvidenceV1(
      resolution,
      evidence as AgentProfileHeadObjectV1[],
      base,
    );
    const transitionDigest = (evidence as AgentProfileHeadObjectV1[])[0]
      .acceptedTransitionDigest;
    const resolutionDigest = computeAgentProfileForkResolutionDigestV1(resolution);
    for (const head of state.parsedHeads.values()) {
      if (
        head.forkResolutionDigest === resolutionDigest &&
        head.acceptedTransitionDigest !== transitionDigest
      ) {
        fail('system-record-closure', 'resolving successor changed accepted-transition lineage');
      }
    }
  }

  const transitionTupleDigests = new Map<string, Digest32V1>();
  for (const [transitionDigest, transition] of state.parsedTransitions) {
    const prior = state.parsedHeads.get(transition.priorHeadDigest);
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

  for (const [headDigest, head] of state.parsedHeads) {
    assertCompleteUniqueRootLineageV1(state, headDigest, head);
    if (head.acceptedTransitionDigest !== undefined) {
      const transition = state.parsedTransitions.get(head.acceptedTransitionDigest);
      if (
        transition === undefined ||
        !isAgentProfileHeadBoundToAcceptedTransitionV1(head, transition)
      ) {
        fail('system-record-closure', `head ${headDigest} does not bind its accepted transition`);
      }
    }
    if (
      headDigest === state.currentHeadDigest &&
      head.forkResolutionDigest !== undefined
    ) {
      const resolution = state.parsedResolutions.find(
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

  for (const head of state.parsedHeads.values()) {
    if (head.state === 'tombstone') {
      const predecessor = state.parsedHeads.get(head.previousHeadDigest);
      if (
        predecessor?.state !== 'active' ||
        !isTombstoneBoundToPredecessorV1(head, predecessor)
      ) {
        fail(
          'system-record-closure',
          'tombstone predecessor is not the exact prior active authority state',
        );
      }
    }
  }
}

function assertCompleteUniqueRootLineageV1(
  state: CollectedClosureV1,
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
    const transition = state.parsedTransitions.get(cursor.acceptedTransitionDigest);
    const prior = transition === undefined
      ? undefined
      : state.parsedHeads.get(transition.priorHeadDigest);
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
    fail('system-record-history', `head ${headDigest} has authority evidence below sequence zero`);
  }
}

function projectVerificationClosureV1(
  state: CollectedClosureV1,
): SystemRecordVerificationClosureV1 {
  const authoritySummary = createVerifiedAuthoritySummaryV1(state);
  const objects = Object.freeze([...state.artifacts].sort(compareClosureObjects));
  return Object.freeze({
    objects,
    canonicalBytes: state.canonicalBytes,
    rootClaims: state.rootClaimCount,
    resolvedForkTuples: state.parsedResolutions.length,
    authoritySummary,
  });
}

function createVerifiedAuthoritySummaryV1(
  state: CollectedClosureV1,
): AgentProfileVerifiedAuthoritySummaryV1 {
  const current = state.parsedHeads.get(state.currentHeadDigest);
  if (current === undefined) {
    fail('system-record-closure', 'verified closure lost its current head');
  }
  const reverseLineage: AgentProfileAppliedTransitionV1[] = [];
  const reverseRoots: string[] = [];
  let cursor = current;
  let sequence = parseCanonicalDecimalU64(current.authoritySequence);
  while (sequence > 0n) {
    const transition = cursor.acceptedTransitionDigest === undefined
      ? undefined
      : state.parsedTransitions.get(cursor.acceptedTransitionDigest);
    const prior = transition === undefined
      ? undefined
      : state.parsedHeads.get(transition.priorHeadDigest);
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
  const tombstonePredecessor = current.state === 'tombstone'
    ? state.parsedHeads.get(current.previousHeadDigest)
    : undefined;
  if (tombstonePredecessor !== undefined && tombstonePredecessor.state !== 'active') {
    fail('system-record-history', 'verified tombstone closure lost its active predecessor');
  }
  const latestTransition = current.acceptedTransitionDigest === undefined
    ? undefined
    : state.parsedTransitions.get(current.acceptedTransitionDigest);
  if (current.authoritySequence !== '0' && latestTransition === undefined) {
    fail('system-record-history', 'verified closure lost its latest authority transition');
  }
  return mintAgentProfileVerifiedAuthoritySummaryV1({
    candidateHeadDigest: state.currentHeadDigest,
    transitionLineage: Object.freeze(reverseLineage.reverse()),
    historicalRoots: Object.freeze(reverseRoots.reverse()),
    lastAuthorityTransitionPriorHeadDigest: latestTransition?.priorHeadDigest,
    tombstonePredecessor:
      tombstonePredecessor?.state === 'active' ? tombstonePredecessor : undefined,
    deletionTableDigest: tombstonePredecessor?.ownedSubjectTableDigest,
  });
}

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
  const execution: ClosureExecutionV1 = Object.freeze({
    nowMs,
    resolve,
    verifyAuthorityEnvelope,
    verifyCurrentBundle,
  });
  const collected = await collectVerificationClosureV1(currentHeadDigest, execution);
  validateCollectedClosureAuthorityV1(collected, nowMs);
  return projectVerificationClosureV1(collected);
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
