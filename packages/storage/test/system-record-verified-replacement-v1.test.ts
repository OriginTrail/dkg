import { readFileSync } from 'node:fs';

import {
  computeKaBundleProjectionDigestV1,
  encodeWorkspaceEncryptionKey,
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  buildAgentProfileVerificationClosureV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  digestSystemRecordBytesV1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type NetworkIdV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it } from 'vitest';

import { createManagedOxigraphOwnershipControllerV1 } from '../src/internal/managed-oxigraph-ownership-v1.js';
import { createSystemRecordNonQueuedReservationGateV1 } from '../src/system-record-reservation-gate-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryV1,
  type SystemRecordActiveReplacementIssueV1,
  type SystemRecordVerifiedReplacementLaneBindingV1,
} from '../src/system-record-verified-replacement-v1-internal.js';
import { resolveOwnedSystemRecordRuntimeV1 } from '../src/system-record-runtime-v1-internal.js';
import { agentProfileIdentityProjectionV1 } from './helpers/agent-profile-identity-projection-v1.js';
import { makeAuthenticTerminalReplacementFixtureV1 } from './helpers/system-record-terminal-replacement-fixture.js';

interface Vectors {
  readonly variants: {
    readonly active: { readonly object: AgentProfileActiveHeadObjectV1 };
  };
  readonly signed: {
    readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 };
  };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;

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
  ].sort(compareProjectionQuads);
}

function projectionBytes(head: Pick<AgentProfileActiveHeadObjectV1,
  'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>): Uint8Array {
  return canonicalBytesFor(projectionFor(head));
}

function canonicalBytesFor(quads: readonly Readonly<{
  subject: string; predicate: string; object: string;
}>[]): Uint8Array {
  return new TextEncoder().encode(
    quads.map((quad) => (
      `${new TextDecoder().decode(tripleContentV10(quad.subject, quad.predicate, quad.object))}\n`
    )).join(''),
  );
}

function projectionContentDigest(head: Pick<AgentProfileActiveHeadObjectV1,
  'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>): `0x${string}` {
  return contentDigestFor(projectionFor(head));
}

function compareProjectionQuads(
  left: Readonly<{ subject: string; predicate: string; object: string }>,
  right: Readonly<{ subject: string; predicate: string; object: string }>,
): number {
  return Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  );
}

function contentDigestFor(quads: readonly Readonly<{
  subject: string; predicate: string; object: string;
}>[]): `0x${string}` {
  const leaves = quads.map((quad) => keccak256(
    tripleContentV10(quad.subject, quad.predicate, quad.object),
  ));
  const contentRoot = V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  );
  return `0x${Buffer.from(contentRoot).toString('hex')}`;
}

async function mintAuthority(
  head: AgentProfileActiveHeadObjectV1,
): Promise<AgentProfileVerifiedAuthoritySummaryV1> {
  const bundle = new TextEncoder().encode('verified-profile-bundle');
  const envelope = {
    ...structuredClone(vectors.signed.activeEip191.envelope),
    object: head,
    objectDigest: computeAgentProfileHeadObjectDigestV1(head),
  } as SignedAgentProfileHeadEnvelopeV1;
  const headBytes = canonicalizeSignedSystemRecordEnvelopeV1(envelope);
  const artifacts = new Map([
    [`agent-profile-head:${envelope.objectDigest}`, {
      objectKind: 'agent-profile-head' as const,
      digest: envelope.objectDigest,
      canonicalBytes: headBytes,
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

const VERIFIED = await (async () => {
  const source = structuredClone(vectors.variants.active.object);
  const canonicalProjectionBytes = projectionBytes(source);
  const contentDigest = projectionContentDigest(source);
  const head = {
    ...source,
    projectionBytes: String(canonicalProjectionBytes.byteLength),
    projectionQuads: String(projectionFor(source).length),
    contentDigest,
    graphScopedAuthorSeal: {
      ...source.graphScopedAuthorSeal,
      assertionMerkleRoot: contentDigest,
      publicTripleCount: String(projectionFor(source).length),
    },
    bundleDigest: digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
      new TextEncoder().encode('verified-profile-bundle'),
    ),
  } as AgentProfileActiveHeadObjectV1;
  return Object.freeze({
    head,
    authority: await mintAuthority(head),
    canonicalProjectionBytes,
  });
})();

function fixture(): {
  readonly input: SystemRecordActiveReplacementIssueV1;
  readonly bindings: SystemRecordVerifiedReplacementLaneBindingV1;
} {
  const head = structuredClone(VERIFIED.head);
  const sessionIdentity = Object.freeze(Object.create(null) as object);
  const bindings = {
    networkId: head.networkId as NetworkIdV1,
    kind: 'agents' as const,
    mode: 'shadow' as const,
    sessionIdentity,
    activationGeneration: '7',
    childGeneration: '11',
    materializationEpoch: '13',
  };
  return {
    bindings,
    input: {
      ...bindings,
      admittedDeadlineMs: 42_000,
      head,
      verifiedAuthoritySummary: VERIFIED.authority,
      canonicalProjectionBytes: new Uint8Array(VERIFIED.canonicalProjectionBytes),
      ownedSubjectTable: [head.rootSubject],
      projectionQuads: projectionFor(head),
    },
  };
}

async function replacementFor(
  projectionQuads: readonly Readonly<{
    subject: string; predicate: string; object: string; graph: string;
  }>[],
  ownedSubjectTable: readonly string[],
): Promise<SystemRecordActiveReplacementIssueV1> {
  const base = fixture().input;
  const canonicalProjectionBytes = canonicalBytesFor(projectionQuads);
  const contentDigest = contentDigestFor(projectionQuads);
  const head = {
    ...base.head,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(
      base.head.rootSubject,
      ownedSubjectTable,
    ),
    ownedSubjectCount: String(ownedSubjectTable.length),
    projectionBytes: String(canonicalProjectionBytes.byteLength),
    projectionQuads: String(projectionQuads.length),
    contentDigest,
    graphScopedAuthorSeal: {
      ...base.head.graphScopedAuthorSeal,
      assertionMerkleRoot: contentDigest,
      publicTripleCount: String(projectionQuads.length),
    },
  } as AgentProfileActiveHeadObjectV1;
  return {
    ...base,
    head,
    verifiedAuthoritySummary: await mintAuthority(head),
    canonicalProjectionBytes,
    projectionQuads,
    ownedSubjectTable,
  };
}

describe('system-record verified replacement V1', () => {
  it('issues exact tombstone facts without retaining a predecessor projection', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1('authoritative');
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const source = [...fixture.tombstone.deletionOwnedSubjectTable];
    const handle = registry.issuer.issueCandidate({
      operation: 'tombstone',
      ...fixture.tombstone,
      deletionOwnedSubjectTable: source,
    });
    source[0] = 'urn:test:mutated';
    const facts = registry.consumer.consume(handle, fixture.binding);

    expect(facts.operation).toBe('tombstone');
    if (facts.operation !== 'tombstone') throw new Error('expected tombstone facts');
    expect(facts.deletionOwnedSubjectTable).toEqual(
      fixture.tombstone.deletionOwnedSubjectTable,
    );
    expect(facts.projectionQuads).toEqual([]);
    expect(facts.ownedSubjectTable).toEqual([]);
    expect(Object.isFrozen(facts.deletionOwnedSubjectTable)).toBe(true);
    registry.consumer.release(facts);
  });

  it('recanonicalizes quarantine evidence and releases failed issue reservations', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const valid = { operation: 'quarantine' as const, ...fixture.quarantine };
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const facts = registry.consumer.consume(
      registry.issuer.issueCandidate(valid),
      fixture.binding,
    );
    expect(facts.operation).toBe('quarantine');
    if (facts.operation !== 'quarantine') throw new Error('expected quarantine facts');
    expect(facts.conflictEvidenceDigest).toBe(fixture.quarantine.conflictEvidenceDigest);
    expect(facts.terminalTransitionConflict).toBe(false);
    registry.consumer.release(facts);

    const {
      conflictEvidenceDigest: _digest,
      canonicalConflictEvidenceBytes: _bytes,
      terminalTransitionConflict: _terminal,
      ...active
    } = fixture.quarantine;

    // This loop is what keeps the terminal-transition flag re-derived rather than
    // trusted. The accepting case cannot do it: with the comparison deleted the
    // flag would be taken on faith, slots would still populate, and every accept
    // test would stay green. The same classification also lives in the receiver,
    // so if storage's copy is ever deleted as redundant, their agreement stops
    // being checked anywhere -- and this is the test that would go red.
    for (const invalid of [
      { ...valid, conflictEvidenceDigest: `0x${'00'.repeat(32)}` },
      { ...valid, terminalTransitionConflict: true },
      {
        ...valid,
        canonicalConflictEvidenceBytes: new Uint8Array((16 * 1024) + 1),
      },
    ]) {
      const isolated = createSystemRecordVerifiedReplacementRegistryV1();
      expect(() => isolated.issuer.issueCandidate(invalid as typeof valid)).toThrow();
      const next = isolated.issuer.issueActive(active);
      isolated.consumer.release(next);
    }
  });

  it('issues an empty frozen handle and returns one deep-owned immutable snapshot', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const sourceQuads = input.projectionQuads as Array<{ object: string }>;
    const sourceSubjects = input.ownedSubjectTable as string[];
    const sourceBytes = input.canonicalProjectionBytes;
    const expectedProjectionDigest = computeKaBundleProjectionDigestV1(sourceBytes);
    const handle = registry.issuer.issueActive(input);

    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.getPrototypeOf(handle)).toBeNull();
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(JSON.stringify(handle)).toBe('{}');

    sourceQuads[0].object = '"mutated"';
    sourceSubjects[0] = 'urn:test:unowned';
    sourceBytes.fill(0);
    const facts = registry.consumer.consume(handle, bindings);
    expect(facts.projectionQuads[0].object).toBe('https://dkg.network/ontology#Agent');
    expect(facts.ownedSubjectTable).toEqual([facts.head.rootSubject]);
    // The authority capability is deliberately retained by identity: core is
    // the only component that can mint it, and the mint freezes both the
    // capability and every nested lineage/root collection. Copying it here
    // would destroy the opaque authority rather than improve ownership.
    expect(facts.verifiedAuthoritySummary).toBe(input.verifiedAuthoritySummary);
    expect(Object.isFrozen(facts.verifiedAuthoritySummary)).toBe(true);
    expect(Object.isFrozen(facts.verifiedAuthoritySummary.transitionLineage)).toBe(true);
    expect(facts.verifiedAuthoritySummary.transitionLineage.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(facts.verifiedAuthoritySummary.historicalRoots)).toBe(true);
    expect(Reflect.set(
      facts.verifiedAuthoritySummary,
      'candidateHeadDigest',
      `0x${'00'.repeat(32)}`,
    )).toBe(false);
    expect(facts.projectionDigest).toBe(expectedProjectionDigest);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.head)).toBe(true);
    expect(Object.isFrozen(facts.ownedSubjectTable)).toBe(true);
    expect(Object.isFrozen(facts.projectionQuads)).toBe(true);
    expect(facts.projectionQuads.every((quad) => Object.isFrozen(quad))).toBe(true);
    expect(facts.projectionQuads.every((quad) => quad.graph === '')).toBe(true);
    expect('sessionIdentity' in facts).toBe(false);
    expect(facts.admittedDeadlineMs).toBe(input.admittedDeadlineMs);
    expect(Object.isFrozen(facts.reservationIdentity)).toBe(true);
    expect(Object.getPrototypeOf(facts.reservationIdentity)).toBeNull();
    expect(Reflect.ownKeys(facts.reservationIdentity)).toEqual([]);
  });

  it('rejects forged, copied, serialized, prototype-bearing, and cross-registry handles', () => {
    const first = createSystemRecordVerifiedReplacementRegistryV1();
    const second = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const handle = first.issuer.issueActive(input);

    for (const forged of [
      {},
      Object.create(null) as object,
      Object.freeze(Object.create(null) as object),
      { ...(handle as object) },
      JSON.parse(JSON.stringify(handle)) as object,
      structuredClone(handle as object),
      Object.create({ brand: 'system-record-verified-replacement-v1' }) as object,
      null,
      undefined,
      'system-record-verified-replacement-v1',
    ]) {
      expect(() => first.consumer.consume(forged, bindings)).toThrow(/handle/);
    }
    expect(() => second.consumer.consume(handle, bindings)).toThrow(/another registry/);
    expect(first.consumer.consume(handle, bindings).head.state).toBe('active');
  });

  it('is one-shot and consumes before returning facts', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const handle = registry.issuer.issueActive(input);
    expect(registry.consumer.consume(handle, bindings).head.peerId).toBe(input.head.peerId);
    expect(() => registry.consumer.consume(handle, bindings)).toThrow(/already consumed/);
  });

  it('keeps one exact nonqueued reservation behind an opaque exact-once lease', () => {
    const gate = createSystemRecordNonQueuedReservationGateV1();
    const bytes = SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES;

    const first = gate.acquire(bytes);
    expect(() => gate.acquire(1)).toThrow(/reservation is already live/);
    first.release();
    expect(() => first.release()).toThrow(/already released/);
    const second = gate.acquire(bytes);
    second.release();
  });

  it('owns one nonqueued atomic reservation and releases handle or facts exactly once', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const first = registry.issuer.issueActive(input);
    expect(() => registry.issuer.issueActive(input)).toThrow(/reservation is already live/);

    registry.consumer.release(first);
    expect(() => registry.consumer.release(first)).toThrow(/already released/);
    const second = registry.issuer.issueActive(input);
    const facts = registry.consumer.consume(second, bindings);
    registry.consumer.release(facts);
    expect(() => registry.consumer.release(facts)).toThrow(/already released/);
    expect(registry.issuer.issueActive(input)).toBeDefined();
  });

  it('resolves one runtime per authentic lease under one process-wide reservation', () => {
    const firstOwnership = createManagedOxigraphOwnershipControllerV1(
      'http://127.0.0.1:7878/query',
      'http://127.0.0.1:7878/update',
    );
    const secondOwnership = createManagedOxigraphOwnershipControllerV1(
      'http://127.0.0.1:7879/query',
      'http://127.0.0.1:7879/update',
    );
    firstOwnership.bindReadyGeneration();
    secondOwnership.bindReadyGeneration();

    const first = resolveOwnedSystemRecordRuntimeV1(firstOwnership.lease);
    const firstAgain = resolveOwnedSystemRecordRuntimeV1(firstOwnership.lease);
    const second = resolveOwnedSystemRecordRuntimeV1(secondOwnership.lease);
    expect(firstAgain).toBe(first);
    expect(second).not.toBe(first);
    expect(() => resolveOwnedSystemRecordRuntimeV1(
      Object.freeze(Object.create(null) as object) as typeof firstOwnership.lease,
    )).toThrow(/authentic managed Oxigraph ownership lease/);

    const { input } = fixture();
    const firstHandle = first.issuer.issueActive(input);
    expect(() => second.issuer.issueActive(input)).toThrow(/reservation is already live/);
    first.consumer.release(firstHandle);

    const secondHandle = second.issuer.issueActive(input);
    second.consumer.release(secondHandle);
  });

  it('keeps ownership liveness outside persisted runtime configuration', () => {
    const ownership = createManagedOxigraphOwnershipControllerV1(
      'http://127.0.0.1:7880/query',
      'http://127.0.0.1:7880/update',
    );
    const runtime = resolveOwnedSystemRecordRuntimeV1(ownership.lease);
    const { input } = fixture();

    expect(() => runtime.issuer.issueActive(input)).toThrow(/ownership lease is not ready/);
    ownership.bindReadyGeneration();
    const handle = runtime.issuer.issueActive(input);
    runtime.consumer.release(handle);
    ownership.invalidate('shutdown');
    expect(() => runtime.issuer.issueActive(input)).toThrow(/ownership lease is not ready/);
  });

  it('refuses diagnostic leases that do not prove the managed listener endpoints', () => {
    const diagnostic = createManagedOxigraphOwnershipControllerV1();
    diagnostic.bindReadyGeneration();
    expect(() => resolveOwnedSystemRecordRuntimeV1(
      diagnostic.lease,
    )).toThrow(/endpoint-bound managed Oxigraph ownership lease/);
  });

  it('holds the process reservation across recovery ownership until settlement', async () => {
    const firstOwnership = createManagedOxigraphOwnershipControllerV1(
      'http://127.0.0.1:7881/query',
      'http://127.0.0.1:7881/update',
    );
    const secondOwnership = createManagedOxigraphOwnershipControllerV1(
      'http://127.0.0.1:7882/query',
      'http://127.0.0.1:7882/update',
    );
    firstOwnership.bindReadyGeneration();
    secondOwnership.bindReadyGeneration();
    const first = resolveOwnedSystemRecordRuntimeV1(firstOwnership.lease);
    const second = resolveOwnedSystemRecordRuntimeV1(secondOwnership.lease);
    const { input, bindings } = fixture();
    const facts = first.consumer.consume(first.issuer.issueActive(input), bindings);
    const ownership = Object.freeze(Object.create(null) as object);
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });

    first.consumer.transferToRecovery(facts, ownership, completion);
    expect(() => second.issuer.issueActive(input)).toThrow(/reservation is already live/);
    settle();
    await completion;
    await Promise.resolve();
    const next = second.issuer.issueActive(input);
    second.consumer.release(next);
  });

  it('discards only a live unconsumed proof and refuses aliases after consumption', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const discarded = registry.issuer.issueActive(input);
    registry.consumer.discardProof(discarded);
    expect(() => registry.consumer.discardProof(discarded)).toThrow(/live and unconsumed/);

    const consumed = registry.issuer.issueActive(input);
    const facts = registry.consumer.consume(consumed, bindings);
    expect(() => registry.consumer.discardProof(consumed)).toThrow(/live and unconsumed/);
    expect(() => registry.consumer.discardProof(facts)).toThrow(/handle/);
    expect(() => registry.issuer.issueActive(input)).toThrow(/reservation is already live/);

    registry.consumer.release(facts);
    expect(registry.issuer.issueActive(input)).toBeDefined();
  });

  it('rejects weighted retained buffers beyond the 12-MiB lease before reuse', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    const facts = registry.consumer.consume(registry.issuer.issueActive(input), bindings);
    expect(() => registry.consumer.replaceCharge(
      facts,
      'prepared',
      12 * 1024 * 1024,
    )).toThrow(/lease capacity exceeded/);
    registry.consumer.replaceCharge(facts, 'prepared', 8 * 1024 * 1024);
    registry.consumer.replaceCharge(facts, 'response', 3 * 1024 * 1024);
    expect(() => registry.consumer.replaceCharge(
      facts,
      'request',
      2 * 1024 * 1024,
    )).toThrow(/lease capacity exceeded/);
    registry.consumer.release(facts);
    expect(registry.issuer.issueActive(input)).toBeDefined();
  });

  it('retains an exact recovery transfer until fulfillment or rejection settles', async () => {
    for (const rejects of [false, true]) {
      const registry = createSystemRecordVerifiedReplacementRegistryV1();
      const { input, bindings } = fixture();
      const facts = registry.consumer.consume(registry.issuer.issueActive(input), bindings);
      const ownership = Object.freeze(Object.create(null) as object);
      let settle!: () => void;
      const completion = new Promise<void>((resolve, reject) => {
        settle = () => rejects ? reject(new Error('terminal unavailable')) : resolve();
      });
      registry.consumer.transferToRecovery(facts, ownership, completion);
      expect(() => registry.consumer.release(facts)).toThrow(/belongs to recovery/);
      expect(() => registry.issuer.issueActive(input)).toThrow(/reservation is already live/);
      settle();
      await completion.catch(() => undefined);
      await Promise.resolve();
      expect(registry.issuer.issueActive(input)).toBeDefined();
    }
  });

  it('rejects every cross-binding substitution without burning the valid handle', () => {
    const variants: Array<[keyof SystemRecordVerifiedReplacementLaneBindingV1, unknown]> = [
      ['networkId', 'otp:999'],
      ['kind', 'not-agents'],
      ['mode', 'authoritative'],
      ['sessionIdentity', Object.freeze(Object.create(null) as object)],
      ['activationGeneration', '8'],
      ['childGeneration', '12'],
      ['materializationEpoch', '14'],
    ];
    for (const [key, value] of variants) {
      const registry = createSystemRecordVerifiedReplacementRegistryV1();
      const { input, bindings } = fixture();
      const handle = registry.issuer.issueActive(input);
      expect(() => registry.consumer.consume(handle, { ...bindings, [key]: value }))
        .toThrow(/lifecycle binding|kind|mode/);
      expect(registry.consumer.consume(handle, bindings).head.state).toBe('active');
    }
  });

  it('rejects caller graph scope, CAS fields, accessors, sparse arrays, and invalid RDF', () => {
    const valid = fixture();
    const attempts: unknown[] = [
      { ...valid.input, graphUri: 'urn:caller:graph' },
      { ...valid.input, stateRevision: '7' },
      {
        ...valid.input,
        canonicalProjectionBytes: Uint8Array.from(
          valid.input.canonicalProjectionBytes,
          (byte, index) => index === 0 ? byte ^ 1 : byte,
        ),
      },
      (() => {
        const projectionQuads = valid.input.projectionQuads.map((quad, index) => (
          index === 2 ? { ...quad, object: '"c"' } : quad
        ));
        return {
          ...valid.input,
          projectionQuads,
          canonicalProjectionBytes: canonicalBytesFor(projectionQuads),
        };
      })(),
      {
        ...valid.input,
        projectionQuads: valid.input.projectionQuads.map((quad, index) => (
          index === 0 ? { ...quad, graph: 'urn:caller:graph' } : quad
        )),
      },
      {
        ...valid.input,
        projectionQuads: [
          { ...valid.input.projectionQuads[0], subject: '_:blank' },
          ...valid.input.projectionQuads.slice(1),
        ],
      },
      {
        ...valid.input,
        projectionQuads: valid.input.projectionQuads.map((quad, index) => (
          index === 2 ? { ...quad, object: `"${'x'.repeat(10_000)}"` } : quad
        )),
      },
      {
        ...valid.input,
        projectionQuads: valid.input.projectionQuads.map((quad, index) => (
          index === 2 ? { ...quad, object: `"${'\u{1f642}'.repeat(10_000)}"` } : quad
        )),
      },
      {
        ...valid.input,
        projectionQuads: [
          { ...valid.input.projectionQuads[0], object: '" } DROP ALL #' },
          ...valid.input.projectionQuads.slice(1),
        ],
      },
      {
        ...valid.input,
        projectionQuads: [
          valid.input.projectionQuads[0],
          valid.input.projectionQuads[0],
          valid.input.projectionQuads[2],
        ],
      },
    ];
    const withAccessor = { ...valid.input } as Record<string, unknown>;
    Object.defineProperty(withAccessor, 'mode', { enumerable: true, get: () => 'shadow' });
    attempts.push(withAccessor);
    const sparse = new Array(3);
    sparse[0] = valid.input.projectionQuads[0];
    sparse[2] = valid.input.projectionQuads[2];
    attempts.push({ ...valid.input, projectionQuads: sparse });

    for (const candidate of attempts) {
      const registry = createSystemRecordVerifiedReplacementRegistryV1();
      expect(() => registry.issuer.issueActive(candidate as SystemRecordActiveReplacementIssueV1))
        .toThrow();
    }
  });

  it('rejects tombstones, head/table/count mismatches, and unowned projection subjects', () => {
    const { input } = fixture();
    const attempts = [
      { ...input, head: { ...input.head, state: 'tombstone' } },
      { ...input, ownedSubjectTable: [] },
      {
        ...input,
        projectionQuads: input.projectionQuads.map((quad, index) => (
          index === 0 ? { ...quad, subject: 'urn:test:other' } : quad
        )),
      },
      {
        ...input,
        verifiedAuthoritySummary: Object.freeze({
          candidateHeadDigest: `0x${'00'.repeat(32)}`,
          transitionLineage: Object.freeze([]),
          historicalRoots: Object.freeze([]),
        }),
      },
    ];
    for (const candidate of attempts) {
      const registry = createSystemRecordVerifiedReplacementRegistryV1();
      expect(() => registry.issuer.issueActive(candidate as SystemRecordActiveReplacementIssueV1))
        .toThrow();
    }
  });

  it('accepts protocol byte ordering for a linked derived subject and canonical literal', async () => {
    const base = fixture();
    const root = base.input.head.rootSubject;
    const capability = `${root}/.well-known/genid/cap1`;
    // Full encoded line ordering puts '/' before the root term's closing '>'.
    const projectionQuads = [
      {
        subject: capability,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://eips.ethereum.org/erc-8004#Capability',
        graph: '',
      },
      {
        subject: root,
        predicate: 'https://eips.ethereum.org/erc-8004#capabilities',
        object: capability,
        graph: '',
      },
      {
        subject: root,
        predicate: 'https://schema.org/name',
        object: '"Meow"@en',
        graph: '',
      },
      ...agentProfileIdentityProjectionV1(base.input.head),
    ].sort(compareProjectionQuads);
    const canonicalProjectionBytes = canonicalBytesFor(projectionQuads);
    const contentDigest = contentDigestFor(projectionQuads);
    const ownedSubjectTable = [root, capability] as const;
    const head = {
      ...base.input.head,
      ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(root, ownedSubjectTable),
      ownedSubjectCount: '2',
      projectionBytes: String(canonicalProjectionBytes.byteLength),
      projectionQuads: String(projectionQuads.length),
      contentDigest,
      graphScopedAuthorSeal: {
        ...base.input.head.graphScopedAuthorSeal,
        assertionMerkleRoot: contentDigest,
        publicTripleCount: String(projectionQuads.length),
      },
    } as AgentProfileActiveHeadObjectV1;
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const handle = registry.issuer.issueActive({
      ...base.input,
      head,
      verifiedAuthoritySummary: await mintAuthority(head),
      canonicalProjectionBytes,
      projectionQuads,
      ownedSubjectTable,
    });
    const facts = registry.consumer.consume(handle, base.bindings);
    expect(facts.projectionQuads.map((quad) => quad.subject)).toEqual(
      projectionQuads.map((quad) => quad.subject),
    );
  });

  it.each([
    ['peerId', '"12D3KooWForeignPeerIdentity"'],
    ['agentAddress', `"0x${'33'.repeat(20)}"`],
    ['publicKey', `"${Buffer.alloc(32, 9).toString('base64')}"`],
  ])('rejects projection %s facts that differ from the authenticated head', async (
    field,
    object,
  ) => {
    const base = fixture().input;
    const predicate = `https://dkg.network/ontology#${field}`;
    const projectionQuads = base.projectionQuads.map((quad) => (
      quad.predicate === predicate ? { ...quad, object } : quad
    ));
    const candidate = await replacementFor(projectionQuads, base.ownedSubjectTable);
    const registry = createSystemRecordVerifiedReplacementRegistryV1();

    expect(() => registry.issuer.issueActive(candidate))
      .toThrow(new RegExp(`signed ${field}`));
  });

  it('rejects unlinked, wrong-kind-linked, and underived encryption subjects', async () => {
    const root = fixture().input.head.rootSubject;
    const capability = `${root}/.well-known/genid/cap1`;
    const underivedKey = `${root}#x25519-${'0'.repeat(32)}`;
    const publicKey = encodeWorkspaceEncryptionKey(new Uint8Array(32).fill(9));
    const candidates = [
      await replacementFor([
        {
          subject: capability,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: 'https://eips.ethereum.org/erc-8004#Capability',
          graph: '',
        },
        { subject: root, predicate: 'https://schema.org/name', object: '"root"', graph: '' },
      ], [root, capability]),
      await replacementFor([
        {
          subject: root,
          predicate: 'https://eips.ethereum.org/erc-8004#capabilities',
          object: `${root}/.well-known/genid/offering1`,
          graph: '',
        },
      ], [root]),
      await replacementFor([
        {
          subject: underivedKey,
          predicate: 'https://dkg.network/ontology#revokedAt',
          object: '"2026-08-05T12:00:00Z"',
          graph: '',
        },
        {
          subject: root,
          predicate: 'https://dkg.network/ontology#publicEncryptionKey',
          object: `"${publicKey}"`,
          graph: '',
        },
      ], [root, underivedKey]),
    ];
    for (const candidate of candidates) {
      const registry = createSystemRecordVerifiedReplacementRegistryV1();
      expect(() => registry.issuer.issueActive(candidate)).toThrow(/linked|link|derived/);
    }
  });

  it('rejects proxies before invoking their traps', () => {
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const { input, bindings } = fixture();
    let traps = 0;
    const trap = () => {
      traps += 1;
      throw new Error('proxy trap must not run');
    };
    const proxiedInput = new Proxy(input, {
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    expect(() => registry.issuer.issueActive(proxiedInput)).toThrow(/Proxy/);
    expect(traps).toBe(0);

    const proxiedAuthority = new Proxy(input.verifiedAuthoritySummary, {
      getPrototypeOf: trap,
      get: trap,
    });
    expect(() => registry.issuer.issueActive({
      ...input,
      verifiedAuthoritySummary: proxiedAuthority,
    })).toThrow(/minted by closure verification/);
    expect(traps).toBe(0);

    const proxiedSeal = new Proxy(input.head.graphScopedAuthorSeal, {
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    expect(() => registry.issuer.issueActive({
      ...input,
      head: { ...input.head, graphScopedAuthorSeal: proxiedSeal },
    })).toThrow(/author seal must not be a Proxy/);
    expect(traps).toBe(0);

    const handle = registry.issuer.issueActive(input);
    const proxiedBindings = new Proxy(bindings, {
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    expect(() => registry.consumer.consume(handle, proxiedBindings)).toThrow(/Proxy/);
    expect(traps).toBe(0);
    expect(registry.consumer.consume(handle, bindings).head.state).toBe('active');
  });

  it('is not exported from the storage package barrel', async () => {
    const storage = await import('../src/index.js');
    expect('createSystemRecordVerifiedReplacementRegistryV1' in storage).toBe(false);
    expect('resolveOwnedSystemRecordRuntimeV1' in storage).toBe(false);
  });
});
