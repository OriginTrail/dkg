import { readFileSync } from 'node:fs';

import {
  computeKaBundleProjectionDigestV1,
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
  computeSystemRecordStableKeyHashV1,
  digestSystemRecordBytesV1,
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type NetworkIdV1,
  type SignedAgentProfileHeadEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import { describe, expect, it } from 'vitest';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

import {
  createSystemRecordAtomicApplyExecutorV1,
  fingerprintSystemRecordProjectionV1,
  type SystemRecordAtomicApplyExecutorDepsV1,
  type SystemRecordAtomicApplyHttpClientV1,
  type SystemRecordAtomicRecoveryRegistrarV1,
  type SystemRecordAtomicRecoveryRequestV1,
} from '../src/system-record-atomic-apply-executor-v1-internal.js';
import {
  deriveSystemRecordActiveReplacementV1,
} from '../src/system-record-next-state-v1-internal.js';
import { parseSystemRecordInspectionResponseV1 } from '../src/system-record-inspection-v1-internal.js';
import {
  decodeSystemRecordAppliedSnapshotV1,
} from '../src/system-record-state-snapshot-v1-internal.js';
import {
  createSystemRecordVerifiedReplacementRegistryV1,
  type SystemRecordActiveReplacementIssueV1,
} from '../src/system-record-verified-replacement-v1-internal.js';
import { SYSTEM_RECORD_V1_PREDICATES, systemRecordEpochSubjectV1 } from '../src/system-record-rdf-schema-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../src/internal-graph-policy.js';
import type { SystemRecordLaneExecutionBindingV1 } from '../src/system-record-materializer-v1.js';
import type { Quad } from '../src/triple-store.js';

interface Vectors {
  readonly variants: { readonly active: { readonly object: AgentProfileActiveHeadObjectV1 } };
  readonly signed: { readonly activeEip191: { readonly envelope: SignedAgentProfileHeadEnvelopeV1 } };
}

const vectors = JSON.parse(readFileSync(new URL(
  '../../core/test/fixtures/system-record-v1/vectors.json',
  import.meta.url,
), 'utf8')) as Vectors;

const VERIFIED = await verifiedFixture(
  projectionFor(vectors.variants.active.object.rootSubject),
  [vectors.variants.active.object.rootSubject],
);

const DERIVED_CAPABILITY =
  `${vectors.variants.active.object.rootSubject}/.well-known/genid/cap1`;
const VERIFIED_WITH_DERIVED_SUBJECT = await verifiedFixture([
  {
    subject: DERIVED_CAPABILITY,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: 'https://eips.ethereum.org/erc-8004#Capability',
    graph: '',
  },
  {
    subject: vectors.variants.active.object.rootSubject,
    predicate: 'https://eips.ethereum.org/erc-8004#capabilities',
    object: DERIVED_CAPABILITY,
    graph: '',
  },
  {
    subject: vectors.variants.active.object.rootSubject,
    predicate: 'https://schema.org/name',
    object: '"Meow"@en',
    graph: '',
  },
], [vectors.variants.active.object.rootSubject, DERIVED_CAPABILITY]);

async function verifiedFixture(
  projectionQuads: readonly Readonly<Quad>[],
  ownedSubjectTable: readonly string[],
) {
  const source = structuredClone(vectors.variants.active.object);
  const canonicalProjectionBytes = canonicalBytesFor(projectionQuads);
  const contentDigest = contentDigestFor(projectionQuads);
  const bundle = new TextEncoder().encode('verified-profile-bundle');
  const head = {
    ...source,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(
      source.rootSubject,
      ownedSubjectTable,
    ),
    ownedSubjectCount: String(ownedSubjectTable.length),
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
    ownedSubjectTable,
  });
}

const NETWORK = VERIFIED.head.networkId as NetworkIdV1;
const EPOCH: Readonly<Quad> = Object.freeze({
  subject: systemRecordEpochSubjectV1(NETWORK),
  predicate: SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
  object: '"2"',
  graph: SYSTEM_RECORD_V1_STATE_GRAPH,
});

describe('bounded system-record atomic apply executor V1', () => {
  it('synchronously discards an authentic proof refused before executor admission', () => {
    const fixture = makeFixture();
    fixture.executor.discard(fixture.proof);
    expect(fixture.issueAgain()).toBeDefined();
    expect(() => fixture.executor.discard(fixture.proof)).toThrow(/live and unconsumed/);
  });

  it('classifies a fully exact pre-read as already-applied without an update', async () => {
    const fixture = makeFixture({ localState: 'next' });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({
      settlement: 'no-mutation',
      outcome: { outcome: 'already-applied' },
    });
    expect(fixture.client.updateCalls).toBe(0);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('rejects equal-head projection drift with unchanged byte and quad counts', async () => {
    const fixture = makeFixture({
      localState: 'next',
      priorProjection: (quads) => quads.map((quad) => ({
        ...quad,
        object: quad.object === '"a"' ? '"c"' : quad.object,
      })),
    });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'deferred', reason: 'validation-mismatch' },
    });
    expect(fixture.client.updateCalls).toBe(0);
  });

  it.each([
    ['missing', (quads: readonly Readonly<Quad>[]) => quads.slice(1)],
    ['extra', (quads: readonly Readonly<Quad>[]) => [...quads, {
      subject: VERIFIED.head.rootSubject,
      predicate: 'https://schema.org/url',
      object: 'https://example.com/profile',
      graph: quads[0]!.graph,
    }]],
  ] as const)('rejects a %s row in the committed local projection', async (_label, mutate) => {
    const fixture = makeFixture({ localState: 'next', priorProjection: mutate });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'deferred', reason: 'validation-mismatch' },
    });
    expect(fixture.client.updateCalls).toBe(0);
  });

  it('atomically replaces a pre-existing legacy row on authoritative cold apply', async () => {
    const fixture = makeFixture({
      priorProjection: () => [{
        subject: VERIFIED.head.rootSubject,
        predicate: 'https://schema.org/name',
        object: '"pre-existing"',
        graph: '',
      }],
    });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({
      settlement: 'settled',
      outcome: { outcome: 'applied' },
    });
    expect(fixture.client.updateCalls).toBe(1);
  });

  it('rejects a pre-existing row in absent shadow storage', async () => {
    const fixture = makeFixture({
      mode: 'shadow',
      priorProjection: () => [{
        subject: VERIFIED.head.rootSubject,
        predicate: 'https://schema.org/name',
        object: '"pre-existing"',
        graph: '',
      }],
    });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'deferred', reason: 'validation-mismatch' },
    });
    expect(fixture.client.updateCalls).toBe(0);
  });

  it.each([
    ['transport failure', { updateFailure: new Error('timeout') }],
    ['non-2xx response', { updateStatus: 500 }],
  ] as const)('transfers %s with an immediate exact-prior read to recovery', async (
    _label,
    update,
  ) => {
    const recoveryCompletion = new Promise<{ readonly resolution: 'unavailable' }>(() => undefined);
    const fixture = makeFixture({ postState: 'prior', recoveryCompletion, ...update });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({
      settlement: 'recovery-owned',
      outcome: { outcome: 'indeterminate' },
    });
    expect(fixture.client.updateCalls).toBe(1);
    const request = fixture.registeredRequest();
    expect(request).toBeDefined();
    const responses = [
      { status: 200, body: selectJson([EPOCH]) },
      { status: 200, body: selectJson([]) },
    ];
    const recoveryClient: SystemRecordAtomicApplyHttpClientV1 = {
      childGeneration: '3',
      isDestroyed: false,
      post: async (_url, _contentType, _body, _timeoutMs, _signal, limits) => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected exact-prior recovery request');
        limits?.reserveResponseCapacity?.(Buffer.byteLength(response.body, 'utf8'));
        return response;
      },
    };
    await expect(request!.reconcile({
      client: recoveryClient,
      queryEndpoint: 'http://127.0.0.1:7878/query',
      absoluteDeadlineMs: performance.now() + 30_000,
      signal: new AbortController().signal,
      assertAttributable: () => true,
    })).resolves.toEqual({ resolution: 'not-applied' });
    expect(responses).toHaveLength(0);
  });

  it('fingerprints a maximum-row projection incrementally in canonical order', () => {
    const quads = Array.from({ length: 10_000 }, (_, index) => ({
      subject: VERIFIED.head.rootSubject,
      predicate: `https://example.com/p/${String(index).padStart(5, '0')}`,
      object: '"v"',
      graph: 'urn:ignored-by-projection-digest',
    }));
    const canonicalBytes = canonicalBytesFor(quads);
    expect(fingerprintSystemRecordProjectionV1(quads)).toEqual({
      digest: computeKaBundleProjectionDigestV1(canonicalBytes),
      bytes: String(canonicalBytes.byteLength),
      quads: '10000',
    });
    expect(() => fingerprintSystemRecordProjectionV1([...VERIFIED.projectionQuads].reverse()))
      .toThrow(/canonical line order/);
  });

  it('defers with zero dispatch when admitted work consumes the apply budget', async () => {
    const fixture = makeFixture({ admittedDeadlineMs: 1_499 });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'deferred', reason: 'insufficient-apply-budget' },
    });
    expect(fixture.client.updateCalls).toBe(0);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it.each([
    ['cross-session', { sessionIdentity: Object.freeze(Object.create(null) as object) }],
    ['stale-generation', { activationGeneration: '9', childGeneration: '10' }],
  ] as const)(
    'discards an authentic %s proof rejected before admission',
    async (_label, stale) => {
      const fixture = makeFixture();
      const result = await fixture.executor.execute(
        fixture.proof,
        Object.freeze({ ...fixture.binding, ...stale }),
        fixture.registerRecovery,
      );
      expect(result).toEqual({
        settlement: 'no-mutation',
        outcome: { outcome: 'capability-lost' },
      });
      expect(fixture.client.calls).toHaveLength(0);
      expect(fixture.issueAgain()).toBeDefined();
    },
  );

  it('refuses to discard a consumed handle when deadline inspection rejects it', async () => {
    const fixture = makeFixture();
    const facts = fixture.consumeProof();
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'capability-lost' },
    });
    expect(() => fixture.issueAgain()).toThrow(/reservation is already live/);

    fixture.releaseFacts(facts);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('discards an unconsumed proof when scheduler admission fails before start', async () => {
    const scheduler: NonNullable<SystemRecordAtomicApplyExecutorDepsV1['scheduler']> = {
      async run<T>(): Promise<T> {
        throw new Error('scheduler admission failed');
      },
    };
    const fixture = makeFixture({ scheduler });
    await expect(fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    )).rejects.toThrow(/scheduler admission failed/);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('discards a proof whose generation becomes stale after scheduler admission', async () => {
    let executionBinding!: SystemRecordLaneExecutionBindingV1;
    const scheduler: NonNullable<SystemRecordAtomicApplyExecutorDepsV1['scheduler']> = {
      async run<T>(_priority, _operation, work): Promise<T> {
        (executionBinding as { childGeneration: string }).childGeneration = '3';
        return work();
      },
    };
    const fixture = makeFixture({ scheduler });
    executionBinding = { ...fixture.binding };
    const result = await fixture.executor.execute(
      fixture.proof,
      executionBinding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'capability-lost' },
    });
    expect(fixture.client.calls).toHaveLength(0);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('issues one update and requires full state, claims, receipt and projection post-read', async () => {
    const fixture = makeFixture({ postState: 'next' });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({ settlement: 'settled', outcome: { outcome: 'applied' } });
    expect(fixture.client.updateCalls).toBe(1);
    expect(fixture.client.calls.filter((call) =>
      call.contentType.startsWith('application/sparql-update'))).toHaveLength(1);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('settles an active projection whose derived subject precedes its root in canonical line order', async () => {
    const fixture = makeFixture({
      verified: VERIFIED_WITH_DERIVED_SUBJECT,
      postState: 'next',
    });
    expect(fixture.exactNextProjection.map((quad) => quad.subject)).toEqual([
      DERIVED_CAPABILITY,
      VERIFIED_WITH_DERIVED_SUBJECT.head.rootSubject,
      VERIFIED_WITH_DERIVED_SUBJECT.head.rootSubject,
    ]);
    expect(parseSystemRecordInspectionResponseV1({
      body: selectJson(fixture.exactNextProjection),
      scope: 'authoritative',
      allowedSubjects: VERIFIED_WITH_DERIVED_SUBJECT.ownedSubjectTable,
      maxRows: fixture.exactNextProjection.length,
    })).toEqual(fixture.exactNextProjection);
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({ settlement: 'settled', outcome: { outcome: 'applied' } });
    expect(fixture.client.updateCalls).toBe(1);
  });

  it('exact-recovers a derived-subject projection in a replacement generation', async () => {
    const recoveryCompletion = new Promise<{ readonly resolution: 'unavailable' }>(() => undefined);
    const fixture = makeFixture({
      verified: VERIFIED_WITH_DERIVED_SUBJECT,
      postState: 'malformed',
      recoveryCompletion,
    });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({ settlement: 'recovery-owned' });

    const responses = [
      { status: 200, body: selectJson(fixture.exactNextReserved) },
      { status: 200, body: selectJson(fixture.exactNextProjection) },
    ];
    const recoveryClient: SystemRecordAtomicApplyHttpClientV1 = {
      childGeneration: '3',
      isDestroyed: false,
      post: async (_url, _contentType, _body, _timeoutMs, _signal, limits) => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected exact-recovery request');
        limits?.reserveResponseCapacity?.(Buffer.byteLength(response.body, 'utf8'));
        return response;
      },
    };
    const abort = new AbortController();
    await expect(fixture.registeredRequest()!.reconcile({
      client: recoveryClient,
      queryEndpoint: 'http://127.0.0.1:7878/query',
      absoluteDeadlineMs: performance.now() + 30_000,
      signal: abort.signal,
      assertAttributable: () => true,
    })).resolves.toMatchObject({ resolution: 'applied' });
    expect(responses).toHaveLength(0);
  });

  it('precharges response text and replaces post-read capacity with its exact prepared weight', async () => {
    const fixture = makeFixture({ postState: 'next' });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result.settlement).toBe('settled');

    const firstDispatch = fixture.accountingEvents.findIndex((event) => event === 'dispatch');
    const firstResponseBytes = fixture.client.calls[0]?.responseBytes;
    expect(firstResponseBytes).toBeGreaterThan(0);
    expect(fixture.accountingEvents[firstDispatch - 1]).toBe(
      `response:${(firstResponseBytes as number) * 3}`,
    );
    expect(fixture.accountingEvents).toContain(`response:${(firstResponseBytes as number) * 2}`);
    expect(fixture.accountingEvents).toContain('response:0');

    const prepared = fixture.accountingEvents
      .filter((event) => event.startsWith('prepared:'))
      .map((event) => Number(event.slice('prepared:'.length)));
    expect(prepared.length).toBeGreaterThan(6);
    expect(prepared.every((bytes) => bytes <= SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES)).toBe(true);
    const update = fixture.client.calls.find((call) =>
      call.contentType.startsWith('application/sparql-update'));
    expect(update).toBeDefined();
    const updateBytes = Buffer.byteLength(update!.body, 'utf8');
    expect(prepared).toContain(updateBytes * 3);
    expect(prepared).toContain(updateBytes * 2);
  });

  it('transfers to recovery when generation attribution is lost on the final post-read', async () => {
    const fixture = makeFixture({
      postState: 'next',
      loseAttributionOnFinalResponse: true,
    });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({
      settlement: 'recovery-owned',
      outcome: { outcome: 'indeterminate' },
    });
    expect(fixture.registeredRequest()).toBeDefined();
  });

  it('returns a no-mutation CAS miss when the exact prior state survives', async () => {
    const fixture = makeFixture({ postState: 'prior' });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toEqual({
      settlement: 'no-mutation',
      outcome: { outcome: 'deferred', reason: 'state-changed' },
    });
    expect(fixture.client.updateCalls).toBe(1);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('registers recovery before the exclusive permit releases on uncertainty', async () => {
    const order: string[] = [];
    const fixture = makeFixture({ postState: 'malformed', order });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result).toMatchObject({
      settlement: 'recovery-owned',
      outcome: { outcome: 'indeterminate', recoveryGeneration: '3' },
    });
    expect(order).toEqual(['exclusive-start', 'recovery-registered', 'exclusive-release']);
    expect(result.settlement === 'recovery-owned' && result.recovery.ownership)
      .toBe(fixture.registeredOwnership());
    await Promise.resolve();
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('throws rather than returning a bare uncertain result when ownership is refused', async () => {
    const fixture = makeFixture({ postState: 'malformed', rejectRecoveryOwnership: true });
    await expect(fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    )).rejects.toThrow(/did not accept the exact ownership token/);
    expect(fixture.issueAgain()).toBeDefined();
  });

  it.each(['queued', 'held'] as const)(
    'aborts %s admission at the issuer deadline without dispatching or leaking the lease',
    async () => {
      const scheduler: NonNullable<SystemRecordAtomicApplyExecutorDepsV1['scheduler']> = {
        async run<T>(_priority, _operation, _work, signal): Promise<T> {
          return await new Promise<T>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      };
      const fixture = makeFixture({
        admittedDeadlineMs: Math.ceil(performance.now() + 10),
        now: () => performance.now(),
        scheduler,
      });
      const result = await fixture.executor.execute(
        fixture.proof,
        fixture.binding,
        fixture.registerRecovery,
      );
      expect(result).toEqual({
        settlement: 'no-mutation',
        outcome: { outcome: 'deferred', reason: 'aborted' },
      });
      expect(fixture.client.calls).toHaveLength(0);
      expect(() => fixture.inspectProof()).toThrow(/no longer live/);
      expect(fixture.issueAgain()).toBeDefined();
    },
  );

  it('transfers the reservation to recovery and releases only after terminal completion', async () => {
    let settleRecovery!: () => void;
    const recoveryCompletion = new Promise<{
      readonly resolution: 'unavailable';
    }>((resolve) => {
      settleRecovery = () => resolve(Object.freeze({ resolution: 'unavailable' as const }));
    });
    const fixture = makeFixture({ postState: 'malformed', recoveryCompletion });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result.settlement).toBe('recovery-owned');
    expect(() => fixture.issueAgain()).toThrow(/reservation is already live/);
    settleRecovery();
    await recoveryCompletion;
    await Promise.resolve();
    expect(fixture.issueAgain()).toBeDefined();
  });

  it('threads lifecycle cancellation into the exact recovery HTTP read and joins its abort', async () => {
    let settleRecovery!: () => void;
    const recoveryCompletion = new Promise<{
      readonly resolution: 'unavailable';
    }>((resolve) => {
      settleRecovery = () => resolve(Object.freeze({ resolution: 'unavailable' as const }));
    });
    const fixture = makeFixture({ postState: 'malformed', recoveryCompletion });
    const result = await fixture.executor.execute(
      fixture.proof,
      fixture.binding,
      fixture.registerRecovery,
    );
    expect(result.settlement).toBe('recovery-owned');

    const abort = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const recoveryClient: SystemRecordAtomicApplyHttpClientV1 = {
      childGeneration: '3',
      isDestroyed: false,
      post: async (_url, _contentType, _body, _timeoutMs, signal) => {
        observedSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const reconcile = fixture.registeredRequest()!.reconcile({
      client: recoveryClient,
      queryEndpoint: 'http://127.0.0.1:7878/query',
      absoluteDeadlineMs: performance.now() + 30_000,
      signal: abort.signal,
      assertAttributable: () => true,
    });
    await Promise.resolve();
    expect(observedSignal).toBe(abort.signal);
    abort.abort(new Error('shutdown'));
    await expect(reconcile).resolves.toEqual({ resolution: 'unavailable' });

    settleRecovery();
    await recoveryCompletion;
  });
});

function makeFixture(options: Readonly<{
  verified?: typeof VERIFIED;
  admittedDeadlineMs?: number;
  localState?: 'absent' | 'next';
  mode?: SystemRecordLaneExecutionBindingV1['mode'];
  postState?: 'next' | 'prior' | 'malformed';
  updateFailure?: Error;
  updateStatus?: number;
  rejectRecoveryOwnership?: boolean;
  order?: string[];
  recoveryCompletion?: Promise<{ readonly resolution: 'unavailable' }>;
  now?: () => number;
  scheduler?: NonNullable<SystemRecordAtomicApplyExecutorDepsV1['scheduler']>;
  loseAttributionOnFinalResponse?: boolean;
  priorProjection?: (
    projection: readonly Readonly<Quad>[],
  ) => readonly Readonly<Quad>[];
}> = {}) {
  const verified = options.verified ?? VERIFIED;
  const order = options.order ?? [];
  const accountingEvents: string[] = [];
  const admittedDeadlineMs = options.admittedDeadlineMs ?? 10_000;
  const binding = Object.freeze({
    activationGeneration: '1',
    networkId: NETWORK,
    kind: 'agents',
    mode: options.mode ?? 'authoritative',
    sessionIdentity: Object.freeze(Object.create(null) as object),
    childGeneration: '2',
    materializationEpoch: '2',
  }) satisfies SystemRecordLaneExecutionBindingV1;

  // A second issued handle supplies factory-authentic facts for calculating
  // the fake store's exact expected response. The executor receives a distinct
  // one-shot handle from the same verifier fixture.
  const expectedRegistry = createSystemRecordVerifiedReplacementRegistryV1();
  const expectedIssue = issue(binding, admittedDeadlineMs, verified);
  const expectedFacts = expectedRegistry.consumer.consume(
    expectedRegistry.issuer.issueActive(expectedIssue),
    binding,
  );
  const absentSnapshot = decodeSystemRecordAppliedSnapshotV1({
    networkId: NETWORK,
    stableKeyHash: computeStableKey(),
    materializationEpoch: '2',
    quads: [EPOCH],
  });
  const ready = deriveSystemRecordActiveReplacementV1({
    facts: expectedFacts,
    snapshot: absentSnapshot,
    observedRootClaimQuads: [],
  });
  if (ready.outcome !== 'ready') throw new Error(`fixture derivation was ${ready.outcome}`);

  const localNext = options.localState === 'next';
  const nextRootSubjects = new Set(ready.next.rootClaimQuads.map((quad) => quad.subject));
  const initialReserved = localNext
    ? ready.nextReservedQuads.filter((quad) => !nextRootSubjects.has(quad.subject))
    : [EPOCH];
  const initialRoots = localNext ? ready.next.rootClaimQuads : [];
  const faithfulInitialProjection = localNext
    ? ready.nextProjectionQuads.map((quad) => ({ ...quad, graph: ready.projectionGraph }))
    : [];
  const initialProjection = options.priorProjection?.(faithfulInitialProjection)
    ?? faithfulInitialProjection;
  const responses: Array<Readonly<{ status: number; body: string }>> = [
    { status: 200, body: selectJson(initialReserved) },
    { status: 200, body: selectJson(initialRoots) },
    { status: 200, body: selectJson(initialProjection) },
  ];
  if (!localNext && admittedDeadlineMs >= 1_500) {
    responses.push({ status: options.updateStatus ?? 204, body: '' });
    if (options.postState === 'malformed') {
      responses.push({ status: 200, body: '{' });
    } else if (options.postState === 'prior') {
      responses.push(
        { status: 200, body: selectJson([EPOCH]) },
        { status: 200, body: selectJson([]) },
      );
    } else {
      responses.push(
        { status: 200, body: selectJson(ready.nextReservedQuads) },
        { status: 200, body: selectJson(ready.nextProjectionQuads.map((quad) => ({
          ...quad,
          graph: ready.projectionGraph,
        }))) },
      );
    }
  }

  let attributable = true;
  const client = new FakeClient(
    responses,
    () => accountingEvents.push('dispatch'),
    (remainingResponses) => {
      if (options.loseAttributionOnFinalResponse && remainingResponses === 0) {
        attributable = false;
      }
    },
    options.updateFailure,
  );
  const registry = createSystemRecordVerifiedReplacementRegistryV1();
  const proof = registry.issuer.issueActive(issue(binding, admittedDeadlineMs, verified));
  const accountedConsumer: typeof registry.consumer = Object.freeze({
    ...registry.consumer,
    replaceCharge: (facts, category, bytes) => {
      registry.consumer.replaceCharge(facts, category, bytes);
      accountingEvents.push(`${category}:${bytes}`);
    },
  });
  let registeredOwnership: object | undefined;
  let registeredRequest: SystemRecordAtomicRecoveryRequestV1 | undefined;
  const registerRecovery: SystemRecordAtomicRecoveryRegistrarV1 = (request) => {
    order.push('recovery-registered');
    registeredOwnership = request.ownership;
    registeredRequest = request;
    return Object.freeze({
      ownership: options.rejectRecoveryOwnership
        ? Object.freeze(Object.create(null) as object)
        : request.ownership,
      recoveryGeneration: '3',
      completion: options.recoveryCompletion
        ?? Promise.resolve(Object.freeze({ resolution: 'unavailable' as const })),
    });
  };
  const defaultScheduler: NonNullable<SystemRecordAtomicApplyExecutorDepsV1['scheduler']> = {
    async run(_priority, _operation, work) {
      order.push('exclusive-start');
      try {
        return await work();
      } finally {
        order.push('exclusive-release');
      }
    },
  };
  const executor = createSystemRecordAtomicApplyExecutorV1({
    consumer: accountedConsumer,
    storeId: Object.freeze(Object.create(null) as object),
    queryEndpoint: 'http://127.0.0.1:7878/query',
    updateEndpoint: 'http://127.0.0.1:7878/update',
    resolveClient: () => attributable ? client : null,
    now: options.now ?? (() => 0),
    scheduler: options.scheduler ?? defaultScheduler,
  });
  return {
    executor,
    proof,
    binding,
    client,
    accountingEvents,
    registerRecovery,
    registeredOwnership: () => registeredOwnership,
    registeredRequest: () => registeredRequest,
    exactNextReserved: ready.nextReservedQuads,
    exactNextProjection: ready.nextProjectionQuads.map((quad) => ({
      ...quad,
      graph: ready.projectionGraph,
    })),
    inspectProof: () => registry.consumer.inspectDeadline(proof, binding),
    consumeProof: () => registry.consumer.consume(proof, binding),
    releaseFacts: (facts: unknown) => registry.consumer.release(facts),
    issueAgain: () => registry.issuer.issueActive(issue(binding, admittedDeadlineMs, verified)),
  };
}

function issue(
  binding: SystemRecordLaneExecutionBindingV1,
  admittedDeadlineMs: number,
  verified = VERIFIED,
): SystemRecordActiveReplacementIssueV1 {
  return {
    ...binding,
    networkId: NETWORK,
    admittedDeadlineMs,
    head: structuredClone(verified.head),
    verifiedAuthoritySummary: verified.authority,
    canonicalProjectionBytes: new Uint8Array(verified.canonicalProjectionBytes),
    projectionQuads: structuredClone(verified.projectionQuads),
    ownedSubjectTable: verified.ownedSubjectTable,
  };
}

function computeStableKey() {
  return computeSystemRecordStableKeyHashV1(NETWORK, VERIFIED.head.peerId);
}

class FakeClient implements SystemRecordAtomicApplyHttpClientV1 {
  readonly childGeneration = '2';
  readonly isDestroyed = false;
  readonly calls: Array<Readonly<{
    contentType: string;
    body: string;
    responseBytes: number;
  }>> = [];
  updateCalls = 0;

  constructor(
    private readonly responses: Array<Readonly<{ status: number; body: string }>>,
    private readonly onPost: () => void = () => undefined,
    private readonly onResponse: (remainingResponses: number) => void = () => undefined,
    private readonly updateFailure?: Error,
  ) {}

  async post(
    _url: string,
    contentType: string,
    body: string,
    _timeoutMs: number,
    _signal?: AbortSignal,
    limits?: Parameters<SystemRecordAtomicApplyHttpClientV1['post']>[5],
  ) {
    const response = this.responses.shift();
    if (response === undefined) throw new Error('unexpected fake request');
    const responseBytes = Buffer.byteLength(response.body, 'utf8');
    limits?.reserveResponseCapacity?.(responseBytes);
    this.onPost();
    this.calls.push({ contentType, body, responseBytes });
    if (contentType.startsWith('application/sparql-update')) {
      this.updateCalls += 1;
      if (this.updateFailure !== undefined) throw this.updateFailure;
    }
    this.onResponse(this.responses.length);
    return response;
  }
}

function projectionFor(root: string) {
  return [
    { subject: root, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#Agent', graph: '' },
    { subject: root, predicate: 'https://schema.org/description', object: '"b"', graph: '' },
    { subject: root, predicate: 'https://schema.org/name', object: '"a"', graph: '' },
  ] as const;
}

function canonicalBytesFor(quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[]) {
  return new TextEncoder().encode(quads.map((quad) =>
    `${new TextDecoder().decode(tripleContentV10(quad.subject, quad.predicate, quad.object))}\n`).join(''));
}

function contentDigestFor(quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[]) {
  const leaves = quads.map((quad) => keccak256(tripleContentV10(quad.subject, quad.predicate, quad.object)));
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

function selectJson(quads: readonly Readonly<Quad>[]): string {
  return JSON.stringify({
    head: { vars: ['s', 'p', 'o'] },
    results: { bindings: quads.map((quad) => ({
      s: { type: 'uri', value: quad.subject },
      p: { type: 'uri', value: quad.predicate },
      o: objectBinding(quad.object),
    })) },
  });
}

function objectBinding(value: string): Readonly<Record<string, string>> {
  if (!value.startsWith('"')) return { type: 'uri', value };
  const parsed = parseRdfLiteralTerm(value);
  if (parsed === null) throw new Error(`unsupported test literal ${value}`);
  return Object.freeze({
    type: 'literal',
    value: parsed.value,
    ...(parsed.kind === 'typed' ? { datatype: parsed.datatype } : {}),
    ...(parsed.kind === 'language' ? { 'xml:lang': parsed.language } : {}),
  });
}
