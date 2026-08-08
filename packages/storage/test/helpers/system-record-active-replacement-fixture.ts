import { readFileSync } from 'node:fs';

import {
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
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

export function makeAuthenticActiveReplacementIssueV1(
  binding: SystemRecordLaneExecutionBindingV1,
  admittedDeadlineMs: number,
): SystemRecordActiveReplacementIssueV1 {
  return issue(binding, admittedDeadlineMs);
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
    registry.issuer.issueActive(issue(binding)),
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

function issue(
  binding: SystemRecordLaneExecutionBindingV1,
  admittedDeadlineMs = 10_000,
): SystemRecordActiveReplacementIssueV1 {
  return {
    ...binding,
    networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
    admittedDeadlineMs,
    head: structuredClone(verified.head),
    verifiedAuthoritySummary: verified.authority,
    canonicalProjectionBytes: new Uint8Array(verified.canonicalProjectionBytes),
    projectionQuads: structuredClone(verified.projectionQuads),
    ownedSubjectTable: [verified.head.rootSubject],
  };
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
