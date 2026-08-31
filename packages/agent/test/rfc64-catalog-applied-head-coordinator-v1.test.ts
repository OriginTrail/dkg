import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  readVerifiedCatalogSealBindingV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import {
  createRfc64CatalogAppliedHeadCoordinatorV1,
} from '../src/rfc64/catalog-applied-head-coordinator-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import type {
  Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1,
  Rfc64PublicCatalogNativeCommittedHeadTokenV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';
import type {
  Rfc64FinalizedVmAgentPrecommitTransactionV1,
} from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import {
  acceptedRfc64VmPolicySnapshot,
  rfc64FinalizedVmPrecommitPlan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';
import {
  createRfc64FinalizedVmPlacementFixture,
  RFC64_VM_AUTHOR,
  RFC64_VM_CONTEXT_GRAPH_NAME,
} from './support/rfc64-finalized-vm-placement-fixture.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function privateSnapshot(source: ContextGraphPolicyV1['source']) {
  const accepted = acceptedRfc64VmPolicySnapshot();
  return Object.freeze({
    ...accepted,
    policy: Object.freeze({
      ...accepted.policy,
      accessPolicy: 1 as const,
      source,
    }),
  });
}

async function seedExactStaleTwin(
  store: OxigraphStore,
  options: { readonly kaNumber?: bigint; readonly marker?: string } = {},
) {
  const kaNumber = options.kaNumber ?? 1n;
  const marker = options.marker ?? 'stale-twin';
  const kaUal = `did:dkg:otp:20430/${RFC64_VM_AUTHOR}/${kaNumber}`;
  const assertionVersion = '2';
  const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
  const vmGraph = knowledgeAssetLayerGraphUri(
    RFC64_VM_CONTEXT_GRAPH_NAME,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  const swmGraph = knowledgeAssetLayerGraphUri(
    RFC64_VM_CONTEXT_GRAPH_NAME,
    MemoryLayer.SharedWorkingMemory,
    scope,
  );
  const payload = [
    { subject: `urn:rfc64:${marker}`, predicate: 'urn:value', object: '"exact"', graph: vmGraph },
    { subject: `urn:rfc64:${marker}`, predicate: 'urn:version', object: '"2"', graph: vmGraph },
  ];
  const merkleRoot = ethers.hexlify(computeFlatKCRootV10(
    payload.map((quad) => ({ ...quad, graph: '' })),
    [],
  ));
  const placement = await createRfc64FinalizedVmPlacementFixture({
    kaNumber,
    assertionRoot: merkleRoot as `0x${string}`,
    publicTripleCount: payload.length,
  });
  const binding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
  const publicQuadsDigest = workspacePublicQuadsDigest(payload);
  const vmMetaGraph = `did:dkg:context-graph:${RFC64_VM_CONTEXT_GRAPH_NAME}/_meta`;
  const swmMetaGraph = contextGraphSharedMemoryMetaUri(RFC64_VM_CONTEXT_GRAPH_NAME);
  const headSubject = `${kaUal}#dkg-swm-head`;
  const shareOperationId = `owner-signed-${marker}`;
  const operationSubject =
    `urn:dkg:share:${RFC64_VM_CONTEXT_GRAPH_NAME}:${shareOperationId}`;
  await store.insert([
    ...payload,
    ...payload.map((quad) => ({ ...quad, graph: swmGraph })),
    { subject: kaUal, predicate: `${DKG}assertionVersion`, object: `"${assertionVersion}"^^<${XSD_INTEGER}>`, graph: vmMetaGraph },
    { subject: kaUal, predicate: `${DKG}assertionGraph`, object: vmGraph, graph: vmMetaGraph },
    { subject: kaUal, predicate: `${DKG}status`, object: '"confirmed"', graph: vmMetaGraph },
    { subject: kaUal, predicate: `${DKG}publicTripleCount`, object: `"${payload.length}"^^<${XSD_INTEGER}>`, graph: vmMetaGraph },
    { subject: kaUal, predicate: `${DKG}privateTripleCount`, object: `"0"^^<${XSD_INTEGER}>`, graph: vmMetaGraph },
    { subject: kaUal, predicate: `${DKG}merkleRoot`, object: `"${merkleRoot}"`, graph: vmMetaGraph },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: kaUal, graph: swmMetaGraph },
    { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"${assertionVersion}"^^<${XSD_INTEGER}>`, graph: swmMetaGraph },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: swmGraph, graph: swmMetaGraph },
    { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${shareOperationId}"`, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}shareOperationId`, object: `"${shareOperationId}"`, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}kaUal`, object: kaUal, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}assertionVersion`, object: `"${assertionVersion}"^^<${XSD_INTEGER}>`, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${publicQuadsDigest}"`, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}publicQuadsCount`, object: `"${payload.length}"^^<${XSD_INTEGER}>`, graph: swmMetaGraph },
    { subject: operationSubject, predicate: `${DKG}privateTripleCount`, object: `"0"^^<${XSD_INTEGER}>`, graph: swmMetaGraph },
  ]);
  return {
    plan: Object.freeze({
      ...rfc64FinalizedVmPrecommitPlan(),
      rows: Object.freeze([Object.freeze({
        authorship: placement.authorship,
        sealBinding: placement.sealBinding,
        publicQuadsDigest,
      })]),
    }),
    evidence: {
      contextGraphId: RFC64_VM_CONTEXT_GRAPH_NAME,
      kaUal,
      assertionVersion,
      publicQuadsDigest,
      publicQuadsCount: payload.length,
      privateTripleCount: 0,
      expectedMerkleRoot: binding.seal.assertionMerkleRoot,
    },
    swmGraph,
  } as const;
}

function transaction(events: string[] = []): Rfc64PublicCatalogNativePrecommitTransactionV1 {
  return {
    commit: vi.fn(async () => { events.push('primary-commit'); }),
    rollback: vi.fn(async () => { events.push('primary-rollback'); }),
  };
}

function finalizedTransaction(
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
  events: string[] = [],
): Rfc64FinalizedVmAgentPrecommitTransactionV1 {
  const primary = transaction(events);
  return Object.freeze({
    kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
    materializationReceipts: Object.freeze(plan.rows.map((row, index) => {
      const binding = readVerifiedCatalogSealBindingV1(row.sealBinding);
      return Object.freeze({
        kaId: binding.kaId,
        ordinal: String(index) as never,
        ual: binding.seal.kaUal,
        status: 'materialized' as const,
        vmGraphIri: `urn:rfc64:test:vm:${index}`,
        tripleCount: binding.seal.publicTripleCount,
        postReadDigest: `0x${String(index + 1).padStart(64, '0')}` as Digest32V1,
      });
    })),
    commit: primary.commit,
    rollback: primary.rollback,
  });
}

function committedHeadToken(
  plan: Readonly<Rfc64PublicCatalogNativeBeforeAppliedHeadCommitPlanV1>,
): Readonly<Rfc64PublicCatalogNativeCommittedHeadTokenV1> {
  return Object.freeze({
    kind: 'rfc64-public-catalog-native-committed-head-token-v1',
    catalogHeadDigest: plan.catalogHeadDigest,
    inventoryDigest: plan.inventoryDigest,
  });
}

describe('RFC-64 catalog applied-head coordinator', () => {
  it('keeps transaction finalization separate from the post-head phase', async () => {
    const events: string[] = [];
    const plan = rfc64FinalizedVmPrecommitPlan();
    const primary = finalizedTransaction(plan, events);
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store: new OxigraphStore(),
      writeLocks: new Map(),
      retire: vi.fn(async () => {}),
    });

    const lifecycle = await handler(
      plan,
      new AbortController().signal,
    );
    expect(lifecycle.kind).toBe('rfc64-public-catalog-native-applied-head-lifecycle-v1');
    expect(lifecycle.transaction).not.toBe(primary);
    expect(events).toEqual([]);
    await lifecycle.transaction!.commit();
    expect(events).toEqual(['primary-commit']);
    await lifecycle.afterAppliedHead!(committedHeadToken(plan));
    expect(events).toEqual(['primary-commit']);
  });

  it('forwards rollback causes through the production wrapper without retiring', async () => {
    const plan = rfc64FinalizedVmPrecommitPlan();
    const primary = finalizedTransaction(plan);
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store: new OxigraphStore(),
      writeLocks: new Map(),
      retire: vi.fn(async () => {}),
    });
    const lifecycle = await handler(
      plan,
      new AbortController().signal,
    );
    const cause = new Error('applied-head CAS rejected');
    await lifecycle.transaction!.rollback(cause);

    expect(primary.rollback).toHaveBeenCalledWith(cause);
  });

  it('rolls back every malformed finalized VM receipt set before commit or retirement', async () => {
    const store = new OxigraphStore();
    const first = await seedExactStaleTwin(store, { kaNumber: 1n, marker: 'receipt-first' });
    const second = await seedExactStaleTwin(store, { kaNumber: 2n, marker: 'receipt-second' });
    const combinedPlan = Object.freeze({
      ...first.plan,
      rows: Object.freeze([...first.plan.rows, ...second.plan.rows]),
    });
    const valid = finalizedTransaction(combinedPlan).materializationReceipts;
    const [firstReceipt, secondReceipt] = valid;
    if (firstReceipt === undefined || secondReceipt === undefined) {
      throw new Error('two-row receipt fixture is incomplete');
    }
    const cases = [
      {
        name: 'wrong kind',
        kind: 'not-a-finalized-vm-transaction',
        receipts: valid,
      },
      {
        name: 'count mismatch',
        kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
        receipts: [firstReceipt],
      },
      {
        name: 'duplicate UAL',
        kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
        receipts: [firstReceipt, Object.freeze({ ...secondReceipt, ual: firstReceipt.ual })],
      },
      {
        name: 'missing UAL',
        kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
        receipts: [firstReceipt, Object.freeze({ ...secondReceipt, ual: 'did:dkg:missing' })],
      },
      {
        name: 'wrong kaId',
        kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
        receipts: [Object.freeze({ ...firstReceipt, kaId: '999' as never }), secondReceipt],
      },
      {
        name: 'wrong tripleCount',
        kind: 'rfc64-finalized-vm-agent-precommit-transaction-v1',
        receipts: [Object.freeze({ ...firstReceipt, tripleCount: '999' as never }), secondReceipt],
      },
    ] as const;

    for (const malformed of cases) {
      const markerGraph = `urn:rfc64:receipt-rollback:${malformed.name.replaceAll(' ', '-')}`;
      const predecessor = [{
        subject: markerGraph,
        predicate: 'urn:rfc64:value',
        object: '"predecessor"',
        graph: markerGraph,
      }];
      await store.insert(predecessor);
      const commit = vi.fn(async () => {});
      const rollback = vi.fn(async () => {
        await store.dropGraph(markerGraph);
        await store.insert(predecessor);
      });
      const retire = vi.fn(async () => {});
      const finalizedVmPrecommit = vi.fn(async () => {
        await store.dropGraph(markerGraph);
        await store.insert([{
          ...predecessor[0]!,
          object: '"uncommitted-target"',
        }]);
        return {
          kind: malformed.kind,
          materializationReceipts: malformed.receipts,
          commit,
          rollback,
        } as unknown as Rfc64FinalizedVmAgentPrecommitTransactionV1;
      });
      const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
        acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
          acceptedRfc64VmPolicySnapshot().policy.source,
        ),
        finalizedPolicyPrecommit: vi.fn(),
        finalizedVmPrecommit,
        store,
        writeLocks: new Map(),
        retire,
      });

      await expect(handler(combinedPlan, new AbortController().signal)).rejects.toThrow();
      expect(rollback, malformed.name).toHaveBeenCalledOnce();
      expect(commit, malformed.name).not.toHaveBeenCalled();
      expect(retire, malformed.name).not.toHaveBeenCalled();
      await expect(store.query(
        `SELECT ?value WHERE { GRAPH <${markerGraph}> { <${markerGraph}> `
          + '<urn:rfc64:value> ?value } }',
      ), malformed.name).resolves.toEqual({
        type: 'bindings',
        bindings: [{ value: '"predecessor"' }],
      });
    }
    await store.close();
  });

  it('reports both malformed receipt validation and rollback failure', async () => {
    const plan = rfc64FinalizedVmPrecommitPlan();
    const store = new OxigraphStore();
    const validationFailureTransaction = {
      kind: 'not-a-finalized-vm-transaction',
      materializationReceipts: [],
      commit: vi.fn(),
      rollback: vi.fn(async () => { throw new Error('rollback failed'); }),
    } as unknown as Rfc64FinalizedVmAgentPrecommitTransactionV1;
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(),
      finalizedVmPrecommit: vi.fn(async () => validationFailureTransaction),
      store,
      writeLocks: new Map(),
      retire: vi.fn(),
    });

    const failure = await handler(plan, new AbortController().signal).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    await store.close();
  });

  it('refuses SWM retirement after VM commit when the durable-head token is absent or wrong', async () => {
    const store = new OxigraphStore();
    const staleTwin = await seedExactStaleTwin(store, { marker: 'missing-token' });
    const primary = finalizedTransaction(staleTwin.plan);
    const retire = vi.fn(async () => {});
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store,
      writeLocks: new Map(),
      retire,
    });
    const lifecycle = await handler(staleTwin.plan, new AbortController().signal);
    await lifecycle.transaction!.commit();

    await expect((lifecycle.afterAppliedHead as (token?: unknown) => Promise<void>)())
      .rejects.toThrow('without the exact durable applied-head token');
    await expect(lifecycle.afterAppliedHead!({
      ...committedHeadToken(staleTwin.plan),
      inventoryDigest: `0x${'00'.repeat(32)}` as never,
    })).rejects.toThrow('without the exact durable applied-head token');
    expect(retire).not.toHaveBeenCalled();
    await store.close();
  });

  it('refuses early SWM retirement before the finalized VM transaction commits', async () => {
    const store = new OxigraphStore();
    const staleTwin = await seedExactStaleTwin(store, { marker: 'early-retirement' });
    const primary = finalizedTransaction(staleTwin.plan);
    const retire = vi.fn(async ({ swmGraph }: { readonly swmGraph: string }) => {
      await store.dropGraph(swmGraph);
    });
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store,
      writeLocks: new Map(),
      retire,
    });
    const lifecycle = await handler(staleTwin.plan, new AbortController().signal);

    await expect(lifecycle.afterAppliedHead!(committedHeadToken(staleTwin.plan))).rejects.toThrow(
      'refusing finalized SWM retirement before the VM transaction commit',
    );
    expect(retire).not.toHaveBeenCalled();
    await expect(store.hasGraph(staleTwin.swmGraph)).resolves.toBe(true);
    await store.close();
  });

  it('reconciles independent post-head twins concurrently and waits for every row', async () => {
    const store = new OxigraphStore();
    const first = await seedExactStaleTwin(store, {
      kaNumber: 1n,
      marker: 'blocked-twin',
    });
    const second = await seedExactStaleTwin(store, {
      kaNumber: 2n,
      marker: 'free-twin',
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const completed: string[] = [];
    const combinedPlan = Object.freeze({
      ...first.plan,
      rows: Object.freeze([...first.plan.rows, ...second.plan.rows]),
    });
    const primary = finalizedTransaction(combinedPlan);
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store,
      writeLocks: new Map(),
      retire: vi.fn(async ({ swmGraph }) => {
        if (swmGraph === first.swmGraph) {
          signalFirstEntered();
          await firstGate;
        }
        completed.push(swmGraph);
      }),
    });
    const lifecycle = await handler(combinedPlan, new AbortController().signal);
    await lifecycle.transaction!.commit();
    const afterAppliedHead = lifecycle.afterAppliedHead!(committedHeadToken(combinedPlan));

    try {
      await firstEntered;
      await vi.waitFor(() => expect(completed).toContain(second.swmGraph));
      // The hook is still pending on the held row even though its independent
      // sibling has completed.
      expect(completed).not.toContain(first.swmGraph);
    } finally {
      releaseFirst();
    }
    const postHeadEvidence = await afterAppliedHead;
    if (postHeadEvidence === undefined) {
      throw new Error('finalized lifecycle did not return its retirement evidence');
    }
    const recorded = postHeadEvidence.finalizedSwmRetirementLifecycleReceipts;
    expect(completed).toEqual(expect.arrayContaining([first.swmGraph, second.swmGraph]));
    expect(recorded).toHaveLength(2);
    expect(recorded.map((receipt) => receipt.kaUal).sort()).toEqual(
      combinedPlan.rows.map((row) => readVerifiedCatalogSealBindingV1(
        row.sealBinding,
      ).seal.kaUal).sort(),
    );
    const expectedPostReadByUal = new Map(primary.materializationReceipts.map(
      ({ ual, postReadDigest }) => [ual, postReadDigest],
    ));
    expect(postHeadEvidence.committedHead).toEqual(committedHeadToken(combinedPlan));
    for (const receipt of recorded) {
      expect(receipt.vmPostReadDigest).toBe(expectedPostReadByUal.get(receipt.kaUal));
      expect(receipt.swmReconciliationOutcome).toBe('retired');
    }
    await store.close();
  });

  it('drains every started twin before propagating failure and records no partial evidence', async () => {
    const store = new OxigraphStore();
    const gated = await seedExactStaleTwin(store, {
      kaNumber: 1n,
      marker: 'drained-gated-twin',
    });
    const rejected = await seedExactStaleTwin(store, {
      kaNumber: 2n,
      marker: 'drained-rejected-twin',
    });
    const combinedPlan = Object.freeze({
      ...gated.plan,
      rows: Object.freeze([...gated.plan.rows, ...rejected.plan.rows]),
    });
    const primary = finalizedTransaction(combinedPlan);
    let signalGatedEntered!: () => void;
    const gatedEntered = new Promise<void>((resolve) => { signalGatedEntered = resolve; });
    let releaseGated!: () => void;
    const gatedRelease = new Promise<void>((resolve) => { releaseGated = resolve; });
    let signalRejectedEntered!: () => void;
    const rejectedEntered = new Promise<void>((resolve) => { signalRejectedEntered = resolve; });
    let gatedFinished = false;
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot(
        acceptedRfc64VmPolicySnapshot().policy.source,
      ),
      finalizedPolicyPrecommit: vi.fn(async () => primary),
      finalizedVmPrecommit: vi.fn(async () => primary),
      store,
      writeLocks: new Map(),
      retire: vi.fn(async ({ swmGraph }) => {
        if (swmGraph === gated.swmGraph) {
          signalGatedEntered();
          await gatedRelease;
          gatedFinished = true;
          return;
        }
        signalRejectedEntered();
        throw new Error('one finalized SWM retirement failed');
      }),
    });
    const lifecycle = await handler(combinedPlan, new AbortController().signal);
    await lifecycle.transaction!.commit();
    const afterAppliedHead = lifecycle.afterAppliedHead!(committedHeadToken(combinedPlan));
    let settled = false;
    void afterAppliedHead.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.all([gatedEntered, rejectedEntered]);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseGated();

    await expect(afterAppliedHead).rejects.toThrow('one finalized SWM retirement failed');
    expect(gatedFinished).toBe(true);
    await store.close();
  });

  it('keeps an exact stale finalized SWM twin under owner-signed-unregistered authority', async () => {
    const store = new OxigraphStore();
    const staleTwin = await seedExactStaleTwin(store);
    const primary = transaction();
    const finalizedPolicyPrecommit = vi.fn(async () => primary);
    const finalizedVmPrecommit = vi.fn(async () => primary);
    const retire = vi.fn(async () => {});
    const handler = createRfc64CatalogAppliedHeadCoordinatorV1({
      acceptedPolicySnapshotForCatalogScope: () => privateSnapshot({
        kind: 'owner-signed-unregistered',
        ownerAddress: RFC64_VM_AUTHOR,
        ownerAuthorityEra: '0',
      }),
      finalizedPolicyPrecommit,
      finalizedVmPrecommit,
      store,
      writeLocks: new Map(),
      retire,
    });

    const lifecycle = await handler(staleTwin.plan, new AbortController().signal);
    expect(lifecycle).toEqual({
      kind: 'rfc64-public-catalog-native-applied-head-lifecycle-v1',
      transaction: primary,
      afterAppliedHead: null,
    });
    await lifecycle.transaction!.commit();
    expect(finalizedPolicyPrecommit).toHaveBeenCalledOnce();
    expect(finalizedVmPrecommit).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(await store.countQuads(staleTwin.swmGraph)).toBe(2);

    // Prove this is not merely an unmatched residue: the same local state and
    // catalog evidence qualify as an exact finalized twin. Policy gating is
    // therefore the only reason the owner-signed activation retained it.
    await expect(reconcileFinalizedSwmTwinFromCatalogProjection({
      store,
      writeLocks: new Map(),
      evidence: staleTwin.evidence,
      retire: async ({ swmGraph }) => store.dropGraph(swmGraph),
    })).resolves.toBe('retired');
  });
});
