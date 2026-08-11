import { readFileSync } from 'node:fs';

import {
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../../src/internal-graph-policy.js';
import {
  deriveSystemRecordActiveReplacementV1,
  type SystemRecordActiveReplacementReadyV1,
} from '../../src/system-record-next-state-v1-internal.js';
import {
  SYSTEM_RECORD_V1_PREDICATES,
  systemRecordEpochSubjectV1,
} from '../../src/system-record-rdf-schema-v1-internal.js';
import { decodeSystemRecordAppliedSnapshotV1 } from '../../src/system-record-state-snapshot-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryV1,
  type SystemRecordActiveReplacementIssueV1,
  type SystemRecordQuarantineReplacementIssueV1,
} from '../../src/system-record-verified-replacement-v1-internal.js';
import type { SystemRecordLaneExecutionBindingV1 } from '../../src/system-record-materializer-v1.js';
import type { Quad } from '../../src/triple-store.js';
import { agentProfileIdentityProjectionV1 } from './agent-profile-identity-projection-v1.js';

interface Vectors {
  readonly variants: { readonly active: { readonly object: AgentProfileActiveHeadObjectV1 } };
  readonly signed: { readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 } };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;

const verified = await (async () => {
  const source = structuredClone(vectors.variants.active.object);
  const projectionQuads = projectionFor(source);
  const canonicalProjectionBytes = canonicalBytesFor(projectionQuads);
  const contentDigest = contentDigestFor(projectionQuads);
  const bundle = new TextEncoder().encode('verified-profile-bundle');
  const head = {
    ...source,
    projectionBytes: String(canonicalProjectionBytes.byteLength),
    projectionQuads: String(projectionQuads.length),
    contentDigest,
    graphScopedAuthorSeal: {
      ...source.graphScopedAuthorSeal,
      assertionMerkleRoot: contentDigest,
      publicTripleCount: String(projectionQuads.length),
    },
    bundleDigest: digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      bundle,
    ),
  } as AgentProfileActiveHeadObjectV1;
  return Object.freeze({
    head,
    authority: await mintAuthority(head, bundle),
    bundle,
    projectionQuads,
    canonicalProjectionBytes,
  });
})();

export const SYSTEM_RECORD_FIXTURE_NETWORK = verified.head.networkId as NetworkIdV1;

export interface AuthenticActiveReplacementFixtureV1 {
  readonly binding: SystemRecordLaneExecutionBindingV1;
  readonly epochQuad: Readonly<Quad>;
  readonly ready: SystemRecordActiveReplacementReadyV1;
}

/** Exercise the real verifier registry, snapshot decoder and transition factory. */
export function makeAuthenticActiveReplacementFixtureV1(
  mode: 'shadow' | 'authoritative' = 'shadow',
): AuthenticActiveReplacementFixtureV1 {
  const binding = Object.freeze({
    activationGeneration: '1',
    networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
    kind: 'agents',
    mode,
    sessionIdentity: Object.freeze(Object.create(null) as object),
    childGeneration: '2',
    materializationEpoch: '2',
  }) satisfies SystemRecordLaneExecutionBindingV1;
  const epochQuad = Object.freeze({
    subject: systemRecordEpochSubjectV1(SYSTEM_RECORD_FIXTURE_NETWORK),
    predicate: SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
    object: '"2"',
    graph: SYSTEM_RECORD_V1_STATE_GRAPH,
  });
  const registry = createSystemRecordVerifiedReplacementRegistryV1();
  const facts = registry.consumer.consume(
    registry.issuer.issueActive(makeSystemRecordActiveReplacementIssueV1(binding)),
    binding,
  );
  const snapshot = decodeSystemRecordAppliedSnapshotV1({
    networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
    stableKeyHash: computeSystemRecordStableKeyHashV1(
      SYSTEM_RECORD_FIXTURE_NETWORK,
      verified.head.peerId,
    ),
    materializationEpoch: binding.materializationEpoch,
    quads: [epochQuad],
  });
  const derivation = deriveSystemRecordActiveReplacementV1({
    facts,
    snapshot,
    observedRootClaimQuads: [],
  });
  if (derivation.outcome !== 'ready') {
    throw new Error(`authentic active fixture derivation was ${derivation.outcome}`);
  }
  return Object.freeze({ binding, epochQuad, ready: derivation });
}

export function makeSystemRecordActiveReplacementIssueV1(
  binding: SystemRecordLaneExecutionBindingV1,
): SystemRecordActiveReplacementIssueV1 {
  return {
    ...binding,
    networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
    admittedDeadlineMs: 10_000,
    head: structuredClone(verified.head),
    verifiedAuthoritySummary: verified.authority,
    canonicalProjectionBytes: new Uint8Array(verified.canonicalProjectionBytes),
    projectionQuads: structuredClone(verified.projectionQuads),
    ownedSubjectTable: [verified.head.rootSubject],
  };
}

const SIBLING_BUNDLE_DIGEST = `0x${'c7'.repeat(32)}` as Digest32V1;
const ALTERNATE_BASE_ISSUED_AT = '2026-08-05T11:59:00Z';
const ROTATION_ISSUERS = [
  '0x5555555555555555555555555555555555555555',
  '0x6666666666666666666666666666666666666666',
] as const;

/**
 * Rotate authority to a new issuer, rebuilding the projection the rotation
 * invalidates: a rotation moves the root subject, and a head commits to a
 * digest of the projection over that root.
 */
function rotatedActiveHead(
  source: AgentProfileActiveHeadObjectV1,
  issuer: string,
  authoritySequence: string,
  version: string,
  history: Readonly<{ previousHeadDigest?: Digest32V1; acceptedTransitionDigest?: Digest32V1 }>,
): AgentProfileActiveHeadObjectV1 {
  const rootSubject = `did:dkg:agent:${issuer}`;
  const draft = {
    ...source,
    authoritySequence,
    version,
    ...history,
    evmIssuer: issuer,
    rootSubject,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(rootSubject, [rootSubject]),
  } as AgentProfileActiveHeadObjectV1;
  const quads = projectionFor(draft);
  const contentDigest = contentDigestFor(quads);
  return {
    ...draft,
    projectionBytes: String(canonicalBytesFor(quads).byteLength),
    projectionQuads: String(quads.length),
    contentDigest,
    graphScopedAuthorSeal: {
      ...source.graphScopedAuthorSeal,
      authorAddress: issuer,
      kaUal: `did:dkg:otp:20430/${issuer}/7`,
      reservedKaId: ((BigInt(issuer) << 96n) | 7n).toString(),
      assertionMerkleRoot: contentDigest,
      publicTripleCount: String(quads.length),
    },
  } as AgentProfileActiveHeadObjectV1;
}

/**
 * Two real authority rotations, so a head derived from the result carries a
 * transition lineage of length two. That is what lets the persisted row's
 * lineage length differ from the forked version, which is the only way a
 * predicate comparing the wrong one of the two can be caught.
 */
function twiceRotatedChain() {
  const initial = structuredClone(verified.head);
  const first = rotationTransition(initial, '1', ROTATION_ISSUERS[0]);
  const middle = rotatedActiveHead(initial, ROTATION_ISSUERS[0], '1', '0', {
    acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(first),
  });
  const second = rotationTransition(middle, '2', ROTATION_ISSUERS[1]);
  const base = rotatedActiveHead(middle, ROTATION_ISSUERS[1], '2', '0', {
    acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(second),
  });
  return {
    base,
    ancestors: [middle, initial] as readonly AgentProfileActiveHeadObjectV1[],
    transitions: [first, second] as readonly AgentProfileAuthorityTransitionV1[],
  };
}

/**
 * One real authority rotation. A resolution built on the result is internally
 * valid at the NEXT authority sequence, which is what a peer offers when it
 * rotates instead of adjudicating the fork it created.
 */
function onceRotatedChain() {
  const initial = structuredClone(verified.head);
  const first = rotationTransition(initial, '1', ROTATION_ISSUERS[0]);
  const base = rotatedActiveHead(initial, ROTATION_ISSUERS[0], '1', '0', {
    acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(first),
  });
  return {
    base,
    ancestors: [initial] as readonly AgentProfileActiveHeadObjectV1[],
    transitions: [first] as readonly AgentProfileAuthorityTransitionV1[],
  };
}

function rotationTransition(
  prior: AgentProfileActiveHeadObjectV1,
  nextAuthoritySequence: string,
  nextEvmIssuer: string,
): AgentProfileAuthorityTransitionV1 {
  return {
    objectType: 'authority-transition',
    kind: 'agents',
    mode: 'co-signed',
    networkId: prior.networkId,
    peerId: prior.peerId,
    peerPublicKey: prior.peerPublicKey,
    priorAuthoritySequence: prior.authoritySequence,
    nextAuthoritySequence,
    priorHeadDigest: computeAgentProfileHeadObjectDigestV1(prior),
    priorEvmIssuer: prior.evmIssuer,
    nextEvmIssuer,
    nextRoot: `did:dkg:agent:${nextEvmIssuer}`,
    issuedAt: '2026-08-05T12:02:00Z',
  } as AgentProfileAuthorityTransitionV1;
}

export interface ForkResolvingSuccessorFixtureV1 {
  readonly resolution: AgentProfileForkResolutionV1;
  /** The resolving successor. */
  readonly head: AgentProfileActiveHeadObjectV1;
  readonly issue: SystemRecordActiveReplacementIssueV1;
  /** Our branch of the fork -- the head a receiver applies and then quarantines. */
  readonly forkedIssue: SystemRecordActiveReplacementIssueV1;
  /** Quarantines our branch on evidence naming both branches of the same fork. */
  readonly quarantineIssue: SystemRecordQuarantineReplacementIssueV1;
  readonly forkBaseHeadDigest?: Digest32V1;
}

/**
 * A fork and the successor that resolves it, built through the real closure so
 * the minted summary carries facts core actually produces.
 *
 * `genesis` forks at version zero, so the resolution names no common base and
 * the successor descends from nothing. `based` forks at version one off a
 * version-zero base, which is the shape that discriminates: its authority
 * sequence, forked version, resolution version and successor version are four
 * distinct numbers, so a predicate comparing the wrong pair cannot pass by
 * coincidence. Use `based` for anything asserting on individual conjuncts.
 *
 * `after-rotate` forks at the same version as `based` but off a base one
 * authority rotation later, so its resolution is valid on its own terms while
 * naming a fork event that is not the one a receiver quarantined at the earlier
 * sequence.
 */
export async function makeForkResolvingSuccessorFixtureV1(
  binding: SystemRecordLaneExecutionBindingV1,
  shape: 'genesis' | 'based' | 'other-version' | 'other-base' | 'rotated' | 'after-rotate'
    = 'genesis',
  terminalTransitionConflict = false,
): Promise<ForkResolvingSuccessorFixtureV1> {
  const genesis = shape === 'genesis';
  const chain = shape === 'rotated'
    ? twiceRotatedChain()
    : shape === 'after-rotate' ? onceRotatedChain() : undefined;
  const origin = chain?.base ?? structuredClone(verified.head);
  // A second version-zero head of the same authority: a different common base,
  // which is what distinguishes two fork events that agree on every other
  // coordinate. It differs by issue time rather than by bundle, so it keeps the
  // one bundle this fixture can resolve while still hashing differently.
  const base = shape === 'other-base'
    ? { ...origin, issuedAt: ALTERNATE_BASE_ISSUED_AT } as AgentProfileActiveHeadObjectV1
    : origin;
  const baseDigest = computeAgentProfileHeadObjectDigestV1(base);
  const forkedVersion = genesis ? '0' : shape === 'other-version' ? '2' : '1';
  const forked = genesis
    ? base
    : { ...base, version: forkedVersion, previousHeadDigest: baseDigest } as AgentProfileActiveHeadObjectV1;
  const sibling = { ...forked, bundleDigest: SIBLING_BUNDLE_DIGEST };
  const resolution = Object.freeze({
    objectType: 'fork-resolution',
    kind: 'agents',
    networkId: origin.networkId,
    peerId: origin.peerId,
    peerPublicKey: origin.peerPublicKey,
    evmIssuer: origin.evmIssuer,
    authoritySequence: origin.authoritySequence,
    forkedVersion,
    resolutionVersion: genesis ? '2' : '3',
    ...(genesis ? {} : { forkBaseHeadDigest: baseDigest }),
    evidenceHeadDigests: Object.freeze(
      [forked, sibling].map(computeAgentProfileHeadObjectDigestV1).sort(),
    ),
    issuedAt: '2026-08-05T12:05:00Z',
  }) as AgentProfileForkResolutionV1;
  const head = {
    ...origin,
    version: genesis ? '3' : shape === 'other-version' ? '5' : '4',
    ...(genesis ? {} : { previousHeadDigest: baseDigest }),
    forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(resolution),
  } as AgentProfileActiveHeadObjectV1;
  const artifacts = buildSystemRecordClosureArtifactsV1(
    [head, forked, sibling, base, ...(chain?.ancestors ?? [])],
    resolution,
    chain?.transitions ?? [],
  );
  const closure = await buildAgentProfileVerificationClosureV1(
    computeAgentProfileHeadObjectDigestV1(head),
    closureOptions(),
  );
  const forkedClosure = genesis
    ? undefined
    : await buildAgentProfileVerificationClosureV1(
      computeAgentProfileHeadObjectDigestV1(forked),
      closureOptions(),
    );
  // A rotation moves the root subject, so the issue must carry the projection
  // over the NEW root -- the derivation recomputes the head's committed digests
  // from exactly these quads and refuses a mismatch.
  const projected = chain === undefined ? {} : (() => {
    const quads = projectionFor(forked);
    return {
      canonicalProjectionBytes: canonicalBytesFor(quads),
      projectionQuads: quads,
      ownedSubjectTable: [forked.rootSubject],
    };
  })();
  const issue = { ...makeSystemRecordActiveReplacementIssueV1(binding), ...projected };
  const forkedIssue = forkedClosure === undefined
    ? issue
    : { ...issue, head: forked, verifiedAuthoritySummary: forkedClosure.authoritySummary };
  const branchDigests = Object.freeze(
    [forked, sibling].map(computeAgentProfileHeadObjectDigestV1).sort(),
  ) as readonly Digest32V1[];
  // A transition-typed entry is what makes a quarantine terminal, and it is the
  // only thing that fills the conflict digest slots: fork-only evidence leaves
  // them empty. A pin needing a slots-carrying row therefore has to come through
  // here rather than assigning the array.
  const evidence = Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: base.networkId,
    peerId: base.peerId,
    entries: Object.freeze([Object.freeze(terminalTransitionConflict
      ? {
        type: 'transition',
        priorAuthoritySequence: forked.authoritySequence,
        nextAuthoritySequence: String(BigInt(forked.authoritySequence) + 1n),
        objectDigests: branchDigests,
      }
      : {
        type: 'fork',
        authoritySequence: forked.authoritySequence,
        version: forked.version,
        objectDigests: branchDigests,
      })]),
  }) as AgentProfileConflictEvidenceV1;
  return Object.freeze({
    resolution,
    head,
    issue: { ...issue, head, verifiedAuthoritySummary: closure.authoritySummary },
    forkedIssue,
    quarantineIssue: {
      ...forkedIssue,
      conflictEvidenceDigest: computeAgentProfileConflictEvidenceDigestV1(evidence),
      canonicalConflictEvidenceBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
      terminalTransitionConflict,
    },
    ...(genesis ? {} : { forkBaseHeadDigest: baseDigest }),
  });

  function closureOptions() {
    return systemRecordClosureResolveOptionsV1(artifacts);
  }
}

/**
 * Assembles the artifact map a verification closure walks.
 *
 * Exported because a closure is minted from more than one place -- the fork
 * fixtures here and the tombstone minter in the terminal fixture -- and two
 * hand-rolled copies of envelope construction is exactly the drift that lets a
 * fixture change land in one and be forgotten in the other. `resolution` is
 * optional: a tombstone closure names no fork.
 */
export function buildSystemRecordClosureArtifactsV1(
  heads: readonly AgentProfileHeadObjectV1[],
  resolution?: AgentProfileForkResolutionV1,
  transitions: readonly AgentProfileAuthorityTransitionV1[] = [],
) {
  const artifacts = new Map<string, {
    objectKind: 'agent-profile-head' | 'fork-resolution' | 'profile-bundle'
      | 'authority-transition';
    digest: Digest32V1;
    canonicalBytes: Uint8Array;
  }>([
    ...heads.map((head) => envelopeArtifact('agent-profile-head', head)),
    ...transitions.map((transition) => envelopeArtifact('authority-transition', transition)),
    ...(resolution === undefined ? [] : [envelopeArtifact('fork-resolution', resolution)]),
  ]);
  artifacts.set(`profile-bundle:${verified.head.bundleDigest}`, {
    objectKind: 'profile-bundle',
    digest: verified.head.bundleDigest,
    canonicalBytes: verified.bundle,
  });
  return artifacts;
}

/**
 * The resolve/verify options every closure in these fixtures is built with, so
 * the callers differ only in the artifacts they supply and the clock they read.
 */
export function systemRecordClosureResolveOptionsV1(
  artifacts: ReadonlyMap<string, { canonicalBytes: Uint8Array }>,
  nowMs: number = Date.parse('2026-08-05T12:10:00Z'),
) {
  return {
    nowMs,
    resolve: async (reference: { objectKind: string; digest: string }) =>
      artifacts.get(`${reference.objectKind}:${reference.digest}`),
    verifyAuthorityEnvelope: () => true,
    verifyCurrentBundle: (_head: unknown, bytes: Uint8Array) =>
      Buffer.from(bytes).equals(Buffer.from(verified.bundle)),
  };
}

/**
 * A real authority chain of `steps` rotations, exported because a NON-GENESIS
 * head cannot be fabricated by editing a genesis one.
 *
 * The constraint is structural and was measured at its site: authority sequence
 * > 0 requires an `acceptedTransitionDigest` (head codec :197), that digest must
 * name a valid authority transition, and a transition MUST "rotate to a new
 * wallet root" (system-record-agent-profile-control-codecs-v1-internal.ts:190).
 * So every non-genesis head is a ROTATED head -- which moves `evmIssuer` and
 * `rootSubject`, and therefore obliges a rebuilt graph-scoped author seal and a
 * re-derived owned-subject table. `rotatedActiveHead` already does all of that;
 * this exposes it rather than inviting the next caller to rebuild it wrongly.
 */
export function makeRotatedAuthorityChainV1(steps: 1 | 2) {
  return steps === 1 ? onceRotatedChain() : twiceRotatedChain();
}

function envelopeArtifact(
  objectKind: 'agent-profile-head' | 'fork-resolution' | 'authority-transition',
  object: AgentProfileHeadObjectV1 | AgentProfileForkResolutionV1
    | AgentProfileAuthorityTransitionV1,
): [string, {
  objectKind: 'agent-profile-head' | 'fork-resolution' | 'authority-transition';
  digest: Digest32V1;
  canonicalBytes: Uint8Array;
}] {
  const digest = object.objectType === 'agent-profile-head'
    ? computeAgentProfileHeadObjectDigestV1(object)
    : object.objectType === 'authority-transition'
      ? computeAgentProfileAuthorityTransitionDigestV1(object)
      : computeAgentProfileForkResolutionDigestV1(object);
  // Signers are rebuilt per role rather than reused from the vector envelope: a
  // rotation changes the object's issuer, and the envelope check rejects a
  // current-evm signature that still names the previous one.
  const template = structuredClone(vectors.signed.activeEip191.envelope);
  const peerEntry = template.signatures.find((entry) => entry.role === 'peer');
  const evmEntry = template.signatures.find((entry) => entry.role !== 'peer');
  const roles = object.objectType === 'authority-transition'
    ? [
      { role: 'peer', signer: object.peerId },
      { role: 'prior-evm', signer: object.priorEvmIssuer },
      { role: 'next-evm', signer: object.nextEvmIssuer },
    ]
    : [
      { role: 'peer', signer: object.peerId },
      { role: 'current-evm', signer: object.evmIssuer },
    ];
  return [`${objectKind}:${digest}`, {
    objectKind,
    digest,
    canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1({
      ...template,
      object,
      objectDigest: digest,
      signatures: roles.map(({ role, signer }) => ({
        ...(role === 'peer' ? peerEntry : evmEntry),
        role,
        signer,
      })),
    } as SignedAgentProfileHeadEnvelopeV1),
  }];
}

function projectionFor(head: Pick<AgentProfileActiveHeadObjectV1,
  'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>) {
  return [
    {
      subject: head.rootSubject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'https://dkg.network/ontology#Agent',
      graph: '',
    },
    ...agentProfileIdentityProjectionV1(head),
    { subject: head.rootSubject, predicate: 'https://schema.org/description', object: '"b"', graph: '' },
    { subject: head.rootSubject, predicate: 'https://schema.org/name', object: '"a"', graph: '' },
  ].sort((left, right) => Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  ));
}

function canonicalBytesFor(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
) {
  return new TextEncoder().encode(quads.map((quad) =>
    `${new TextDecoder().decode(tripleContentV10(quad.subject, quad.predicate, quad.object))}\n`)
    .join(''));
}

function contentDigestFor(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
) {
  const leaves = quads.map((quad) =>
    keccak256(tripleContentV10(quad.subject, quad.predicate, quad.object)));
  return `0x${Buffer.from(V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  )).toString('hex')}` as const;
}

async function mintAuthority(
  head: AgentProfileActiveHeadObjectV1,
  bundle: Uint8Array,
): Promise<AgentProfileVerifiedAuthoritySummaryV1> {
  const envelope = {
    ...structuredClone(vectors.signed.activeEip191.envelope),
    object: head,
    objectDigest: computeAgentProfileHeadObjectDigestV1(head),
  } as SignedAgentProfileHeadEnvelopeV1;
  const artifacts = new Map([
    [`agent-profile-head:${envelope.objectDigest}`, {
      objectKind: 'agent-profile-head' as const,
      digest: envelope.objectDigest,
      canonicalBytes: canonicalizeSignedSystemRecordEnvelopeV1(envelope),
    }],
    [`profile-bundle:${head.bundleDigest}`, {
      objectKind: 'profile-bundle' as const,
      digest: head.bundleDigest,
      canonicalBytes: bundle,
    }],
  ]);
  const closure = await buildAgentProfileVerificationClosureV1(envelope.objectDigest, {
    nowMs: Date.parse('2026-08-05T12:10:00Z'),
    resolve: async (reference) => artifacts.get(`${reference.objectKind}:${reference.digest}`),
    verifyAuthorityEnvelope: () => true,
    verifyCurrentBundle: (_head, bytes) => Buffer.from(bytes).equals(Buffer.from(bundle)),
  });
  return closure.authoritySummary;
}
