import { join } from 'node:path';
import { deriveCanonicalGraphScopedAuthorSealPlacementV1 } from '@origintrail-official/dkg-core';
import { GraphSetIndexStore, OxigraphStore } from '@origintrail-official/dkg-storage';
import { expect, vi } from 'vitest';
import { type Rfc64PersistenceV1 } from '../../src/rfc64/persistence-v1.js';
import {
  AUTHOR,
  CONTEXT_GRAPH_ID,
  KA_NUMBER,
  readExactSemanticPairForTest,
  setTransactionTestVmGeneration,
  readTransactionTestVmGeneration,
} from './native-gate1-fixture-values.js';
import { createNativeGate1FixtureOwner } from './native-gate1-fixture.js';

export type CatalogDurabilityBoundary = 'before-flush' | 'before-cas' | 'after-cas';
export interface CatalogDurabilityEvidence {
  receiverDirectory: string; snapshot: string; scopeDigest: string; author: string;
  predecessor: string; target: string; predecessorState: unknown; targetState: unknown;
  backgroundWritesHeld: number;
}

export async function runCatalogDurabilityScenario(
  fixture: Awaited<ReturnType<ReturnType<typeof createNativeGate1FixtureOwner>['setupLiveReceiver']>>,
  options: {
    readonly mode?: 'transition' | 'restart';
    readonly onBoundary?: (stage: CatalogDurabilityBoundary, evidence: CatalogDurabilityEvidence) => void;
  } = {},
): Promise<void> {
  const snapshot = join(fixture.receiverDirectory, 'store.nq');
  const raw = new OxigraphStore(snapshot);
  const store = new GraphSetIndexStore(raw);
  // Freeze only the debounced background path. Production flush() remains
  // untouched, and the observed schedule calls prove this fault was reached.
  const scheduled = vi.spyOn(raw as unknown as { scheduleFlush(): void }, 'scheduleFlush')
    .mockImplementation(() => {});
  let persistedAtCas: OxigraphStore | undefined;
  try {
    if (options.mode === 'restart') {
      const restarted = fixture.createReceiver(fixture.receiverPersistence.inventory,
        undefined, undefined, store, async () => {
          await setTransactionTestVmGeneration(store, 'target');
        });
      await fixture.synchronize(fixture.announcement, restarted);
      await expect(raw.countQuads()).resolves.toBe(17);
      await expect(readTransactionTestVmGeneration(raw)).resolves.toBe('target');
      const reopened = new OxigraphStore(snapshot);
      await expect(reopened.countQuads()).resolves.toBe(17);
      expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
        fixture.scopeDigest, AUTHOR,
      )?.currentCatalogHeadDigest).toBe(fixture.successor.head.objectDigest);
      return;
    }
    const initial = fixture.createReceiver(fixture.receiverPersistence.inventory,
      undefined, undefined, store);
    await fixture.bootstrap(fixture.genesisAnnouncement, initial);
    await setTransactionTestVmGeneration(store, 'predecessor');
    await raw.flush(); // Establish the durable predecessor before the transition.
    scheduled.mockClear();
    const boundary = {
      receiverDirectory: fixture.receiverDirectory, snapshot, scopeDigest: fixture.scopeDigest,
      author: AUTHOR, predecessor: fixture.genesis.head.objectDigest,
      target: fixture.successor.head.objectDigest,
      predecessorState: await store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o'),
      targetState: null as unknown, backgroundWritesHeld: 0,
    };
    const cas = vi.fn((...args: Parameters<
      Rfc64PersistenceV1['inventory']['compareAndSwapAppliedCatalogHeadV1']
    >) => {
      options.onBoundary?.('before-cas', boundary);
      persistedAtCas = new OxigraphStore(snapshot);
      const result = fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1(...args);
      options.onBoundary?.('after-cas', boundary);
      return result;
    });
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1: fixture.receiverPersistence.inventory
        .readAppliedCatalogHeadV1.bind(fixture.receiverPersistence.inventory),
      compareAndSwapAppliedCatalogHeadV1: cas,
    }, undefined, undefined, store, async () => {
      await setTransactionTestVmGeneration(store, 'target');
      expect(scheduled).toHaveBeenCalled();
      boundary.targetState = await store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
      boundary.backgroundWritesHeld = scheduled.mock.calls.length;
      options.onBoundary?.('before-flush', boundary);
      return { commit: () => {}, rollback: async () => {
        await setTransactionTestVmGeneration(store, 'predecessor');
      } };
    });
    await fixture.synchronize(fixture.announcement, receiver);
    expect(cas).toHaveBeenCalledOnce();
    await expect(persistedAtCas!.countQuads()).resolves.toBe(17);
    await expect(readTransactionTestVmGeneration(persistedAtCas!)).resolves.toBe('target');
    const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
      contextGraphId: CONTEXT_GRAPH_ID, subGraphName: null, authorAddress: AUTHOR,
      assertionCoordinate: 'gate-1-object' as never,
    });
    const graph = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory/${AUTHOR}/${KA_NUMBER}`;
    await expect(readExactSemanticPairForTest(persistedAtCas!, graph,
      placement.metaGraph, placement.subject)).resolves.toEqual(
      await readExactSemanticPairForTest(store, graph,
        placement.metaGraph, placement.subject),
    );
  } finally {
    scheduled.mockRestore();
    await raw.close();
  }
}
