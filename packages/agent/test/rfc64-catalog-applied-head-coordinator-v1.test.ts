import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  contextGraphSharedMemoryMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  readVerifiedCatalogSealBindingV1,
  type ContextGraphPolicyV1,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { createRfc64CatalogAppliedHeadCoordinatorV1 } from
  '../src/rfc64/catalog-applied-head-coordinator-v1.js';
import {
  reconcileFinalizedSwmTwinFromCatalogProjection,
} from '../src/sync/requester/finalized-swm-twin-reconciliation.js';
import type {
  Rfc64PublicCatalogNativeAppliedHeadLifecycleV1,
  Rfc64PublicCatalogNativePrecommitTransactionV1,
} from '../src/rfc64/public-catalog-native-receiver-v1.js';
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

async function seedExactStaleTwin(store: OxigraphStore) {
  const kaUal = `did:dkg:otp:20430/${RFC64_VM_AUTHOR}/1`;
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
    { subject: 'urn:rfc64:stale-twin', predicate: 'urn:value', object: '"exact"', graph: vmGraph },
    { subject: 'urn:rfc64:stale-twin', predicate: 'urn:version', object: '"2"', graph: vmGraph },
  ];
  const merkleRoot = ethers.hexlify(computeFlatKCRootV10(
    payload.map((quad) => ({ ...quad, graph: '' })),
    [],
  ));
  const placement = await createRfc64FinalizedVmPlacementFixture({
    assertionRoot: merkleRoot as `0x${string}`,
    publicTripleCount: payload.length,
  });
  const binding = readVerifiedCatalogSealBindingV1(placement.sealBinding);
  const publicQuadsDigest = workspacePublicQuadsDigest(payload);
  const vmMetaGraph = `did:dkg:context-graph:${RFC64_VM_CONTEXT_GRAPH_NAME}/_meta`;
  const swmMetaGraph = contextGraphSharedMemoryMetaUri(RFC64_VM_CONTEXT_GRAPH_NAME);
  const headSubject = `${kaUal}#dkg-swm-head`;
  const shareOperationId = 'owner-signed-stale-twin';
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

describe('RFC-64 catalog applied-head coordinator', () => {
  it('keeps transaction finalization separate from the post-head phase', async () => {
    const events: string[] = [];
    const primary = transaction(events);
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

    const returned = await handler(rfc64FinalizedVmPrecommitPlan(), new AbortController().signal);
    const lifecycle = returned as Rfc64PublicCatalogNativeAppliedHeadLifecycleV1;
    expect(lifecycle.transaction).toBe(primary);
    expect(events).toEqual([]);
    await lifecycle.transaction!.commit();
    expect(events).toEqual(['primary-commit']);
    await lifecycle.afterAppliedHead!();
    expect(events).toEqual(['primary-commit']);
  });

  it('forwards rollback causes through the production wrapper without retiring', async () => {
    const primary = transaction();
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
    const returned = await handler(rfc64FinalizedVmPrecommitPlan(), new AbortController().signal);
    const lifecycle = returned as Rfc64PublicCatalogNativeAppliedHeadLifecycleV1;
    const cause = new Error('applied-head CAS rejected');
    await lifecycle.transaction!.rollback(cause);

    expect(primary.rollback).toHaveBeenCalledWith(cause);
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

    const returned = await handler(staleTwin.plan, new AbortController().signal);
    expect(returned).toBe(primary);
    await primary.commit();
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
