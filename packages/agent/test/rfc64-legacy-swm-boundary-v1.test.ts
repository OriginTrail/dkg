// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  contextGraphSharedMemoryMetaUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  type Quad,
  type QueryResult,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  markRfc64LegacySwmRepublishedV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';
import { legacySwmBoundaryFixtureQuadsV1 } from
  './_helpers/legacy-swm-boundary-fixture.js';

const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/legacy-boundary';
const META_GRAPH = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID);
const SUBGRAPH_META_GRAPH = contextGraphSharedMemoryMetaUri(
  CONTEXT_GRAPH_ID,
  'private-lane',
);
const UAL_ONE = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const UAL_TWO = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2';

describe('RFC-64 10.0.16 legacy SWM boundary', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })));
  });

  it('captures once, remains private by count, and retires only after explicit republish', async () => {
    const root = await secureTempRoot(roots);
    const heads = new Map<string, string[]>([
      [META_GRAPH, [UAL_ONE]],
      [SUBGRAPH_META_GRAPH, []],
    ]);
    const store = fakeStore(heads);
    const firstOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(firstOwner, root, store);

    expect(readRfc64LegacySwmBoundaryCountV1(firstOwner, CONTEXT_GRAPH_ID)).toBe(1);

    // A later restart must load the immutable first-upgrade capture instead of
    // silently classifying a new 10.0.16 share as historical.
    heads.set(SUBGRAPH_META_GRAPH, [UAL_TWO]);
    const restartedOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(restartedOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);

    // A non-captured UAL is a no-op; the captured UAL is cleared only after the
    // caller has already committed its exact catalog projection.
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_TWO, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(0);

    const secondRestartOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(secondRestartOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(secondRestartOwner, CONTEXT_GRAPH_ID)).toBe(0);
    expect(store.listGraphs).not.toHaveBeenCalled();
  });

  it('persists an atomic post-capture legacy SHARE companion until that exact UAL is republished', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const firstOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(firstOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(firstOwner, CONTEXT_GRAPH_ID)).toBe(0);

    const companion = prepareRfc64LateLegacySwmBoundaryV1(
      firstOwner,
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'late-legacy-share-one',
      '1',
    );
    await store.replaceGraphAndSubject!(
      'urn:test:late-legacy-swm',
      [{
        graph: 'urn:test:late-legacy-swm',
        subject: 'urn:test:entity',
        predicate: 'urn:test:predicate',
        object: '"value"',
      }],
      companion.graphUri,
      companion.subject,
      [...companion.quads],
    );
    companion.settle(true);
    expect(readRfc64LegacySwmBoundaryCountV1(firstOwner, CONTEXT_GRAPH_ID)).toBe(1);

    const restartedOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(restartedOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_TWO, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(0);

    const secondRestartOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(secondRestartOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(secondRestartOwner, CONTEXT_GRAPH_ID)).toBe(0);
  });

  it('keeps a newer same-UAL generation while an older catalog retirement races its commit', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);
    const swmGraph = 'urn:test:same-ual-generations';
    const swmQuad = (version: string) => ({
      graph: swmGraph,
      subject: 'urn:test:entity',
      predicate: 'urn:test:version',
      object: JSON.stringify(version),
    });

    const first = prepareRfc64LateLegacySwmBoundaryV1(
      owner,
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'same-ual-generation-one',
      '1',
    );
    await store.replaceGraphAndSubject!(
      swmGraph,
      [swmQuad('1')],
      first.graphUri,
      first.subject,
      [...first.quads],
    );
    first.settle(true);

    const second = prepareRfc64LateLegacySwmBoundaryV1(
      owner,
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'same-ual-generation-two',
      '2',
    );
    const retireFirst = markRfc64LegacySwmRepublishedV1(
      owner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '1' }],
    );
    expect(() => prepareRfc64LateLegacySwmBoundaryV1(
      owner,
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'same-ual-generation-three',
      '3',
    )).toThrow('retirement is in progress');
    await store.replaceGraphAndSubject!(
      swmGraph,
      [swmQuad('2')],
      second.graphUri,
      second.subject,
      [...second.quads],
    );
    second.settle(true);
    await retireFirst;
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);

    const restartedOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(restartedOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      restartedOwner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '2' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(0);
  });

  it('fails closed when persistent boundary state was not initialized', () => {
    expect(() => prepareRfc64LateLegacySwmBoundaryV1(
      {},
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'missing-persistence',
      '1',
    )).toThrow('boundary persistence is unavailable');
  });

  it('rolls back only a newly prepared process-local witness on a known non-commit', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);

    const companion = prepareRfc64LateLegacySwmBoundaryV1(
      owner,
      CONTEXT_GRAPH_ID,
      UAL_ONE,
      'clean-capability-refusal',
      '1',
    );
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);
    companion.settle(false);
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(0);

    const restartedOwner = {};
    await initializeRfc64LegacySwmBoundaryV1(restartedOwner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(restartedOwner, CONTEXT_GRAPH_ID)).toBe(0);
  });

  it('fails closed when a head subject and its canonical UAL differ', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const corruptHead = `${UAL_TWO}#dkg-swm-head`;
    await store.insert(legacySwmBoundaryFixtureQuadsV1({
      graph: META_GRAPH,
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: UAL_ONE,
      operation: 'urn:dkg:workspace-operation:corrupt-head',
      head: {
        subject: corruptHead,
        shareOperationId: 'corrupt-share',
      },
      operationShareOperationIds: ['corrupt-share'],
    }));

    await expect(initializeRfc64LegacySwmBoundaryV1({}, root, store)).rejects.toThrow(
      `RFC-64 legacy SWM head identity differs for ${UAL_ONE}`,
    );
  });

  it('captures only the exact root when root and named-subgraph heads coexist', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    await store.insert([
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_ONE,
        operation: 'urn:dkg:workspace-operation:root',
        head: { shareOperationId: 'share-root' },
        operationShareOperationIds: ['share-root'],
      }),
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: SUBGRAPH_META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_TWO,
        operation: 'urn:dkg:workspace-operation:named',
        head: { shareOperationId: 'share-named' },
        operationShareOperationIds: ['share-named'],
      }),
    ]);

    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);

    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      owner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(0);
  });

  it('does not let named metadata graphs consume the root graph capture cap', async () => {
    const root = await secureTempRoot(roots);
    const heads = new Map<string, string[]>([[META_GRAPH, [UAL_ONE]]]);
    for (let index = 0; index < 16_384; index += 1) {
      heads.set(
        contextGraphSharedMemoryMetaUri(CONTEXT_GRAPH_ID, `named-${index}`),
        [],
      );
    }
    const store = fakeStore(heads);

    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);

    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);
    expect(store.listGraphs).not.toHaveBeenCalled();
    expect(store.query).toHaveBeenCalledWith(
      expect.stringContaining('GRAPH ?metaGraph'),
      expect.objectContaining({
        source: 'agent.rfc64.legacySwmBoundary.readHeads',
      }),
    );
  });

  it('uses one bounded fully correlated capture query', async () => {
    const root = await secureTempRoot(roots);
    const store = fakeStore(new Map([[META_GRAPH, [UAL_ONE]]]));

    await initializeRfc64LegacySwmBoundaryV1({}, root, store);

    const captureQueryCalls = vi.mocked(store.query).mock.calls.filter(([, options]) => (
      options?.source === 'agent.rfc64.legacySwmBoundary.readHeads'
    ));
    expect(captureQueryCalls).toHaveLength(1);
    const captureQuery = captureQueryCalls[0]![0];
    expect(captureQuery).toContain(
      '?operation <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>',
    );
    expect(captureQuery).toContain(
      'BIND(?operationUal AS ?ual)',
    );
    expect(captureQuery).toContain(
      '?head <http://dkg.io/ontology/kaUal> ?ual ; <http://dkg.io/ontology/shareOperationId> ?shareId',
    );
    expect(captureQuery).toContain('LIMIT 100001');
    expect(captureQuery).toContain(
      'FILTER(STRENDS(STR(?head), "#dkg-swm-head"))',
    );
    expect(captureQuery).not.toContain('VALUES');
    expect(captureQuery).not.toContain('queryHints#');
  });

  it.each([
    {
      name: 'a non-binding capture result',
      captureResult: { type: 'boolean', value: true } as const,
      error: 'query did not return bindings',
    },
    {
      name: 'an incomplete head binding',
      captureResult: {
        type: 'bindings',
        bindings: [{
          metaGraph: META_GRAPH,
          ual: UAL_ONE,
          contextGraphId: `"${CONTEXT_GRAPH_ID}"`,
        }],
      } as const,
      error: 'returned an incomplete head',
    },
  ])('fails closed on $name', async ({ captureResult, error }) => {
    const root = await secureTempRoot(roots);
    const store = scriptedCaptureStore(captureResult as QueryResult);

    await expect(
      initializeRfc64LegacySwmBoundaryV1({}, root, store),
    ).rejects.toThrow(error);
  });

  it('rejects 100001 fully joined heads using valid binding rows', async () => {
    const root = await secureTempRoot(roots);
    const bindings = Array.from({ length: 100_001 }, (_, index) => {
      const ual = testUal(index + 1);
      return captureBinding(CONTEXT_GRAPH_ID, ual);
    });
    const store = scriptedCaptureStore({ type: 'bindings', bindings });

    await expect(
      initializeRfc64LegacySwmBoundaryV1({}, root, store),
    ).rejects.toThrow('exceeds head limit 100000');
  });

  it('rejects 16385 valid root metadata graphs', async () => {
    const root = await secureTempRoot(roots);
    const bindings = Array.from({ length: 16_385 }, (_, index) => {
      const contextGraphId =
        `0x1111111111111111111111111111111111111111/graph-limit-${index + 1}`;
      return captureBinding(contextGraphId, UAL_ONE);
    });
    const store = scriptedCaptureStore({ type: 'bindings', bindings });

    await expect(
      initializeRfc64LegacySwmBoundaryV1({}, root, store),
    ).rejects.toThrow('exceeds metadata graph limit 16384');
  });

  it('captures only fully joined legacy heads through the real Oxigraph query', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const quads: Quad[] = [
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_ONE,
        operation: 'urn:dkg:workspace-operation:one',
        head: { shareOperationId: 'share-one' },
        operationShareOperationIds: ['share-one'],
      }),
      // This head looks plausible but its operation carries another share id,
      // so the production join must not classify it as a captured legacy row.
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_TWO,
        operation: 'urn:dkg:workspace-operation:two',
        head: { shareOperationId: 'share-two' },
        operationShareOperationIds: ['different-share'],
      }),
    ];
    // Concrete repeated history exercises the real store's join and DISTINCT
    // semantics. None of these old share IDs matches the one current head.
    for (let index = 0; index < 512; index += 1) {
      quads.push(...legacySwmBoundaryFixtureQuadsV1({
        graph: META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_ONE,
        operation: `urn:dkg:workspace-operation:one-old-${index}`,
        operationShareOperationIds: [`share-one-old-${index}`],
      }));
    }
    await store.insert(quads);

    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      owner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_TWO, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(1);
    await markRfc64LegacySwmRepublishedV1(
      owner,
      CONTEXT_GRAPH_ID,
      [{ kaUal: UAL_ONE, assertionVersion: '1' }],
    );
    expect(readRfc64LegacySwmBoundaryCountV1(owner, CONTEXT_GRAPH_ID)).toBe(0);
  });

  it('captures two root metadata graphs in one query', async () => {
    const root = await secureTempRoot(roots);
    const secondContextGraphId =
      '0x1111111111111111111111111111111111111111/legacy-boundary-two';
    const secondMetaGraph = contextGraphWorkspaceMetaGraphUri(
      secondContextGraphId,
    );
    const store = new OxigraphStore();
    await store.insert([
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: META_GRAPH,
        contextGraphId: CONTEXT_GRAPH_ID,
        ual: UAL_ONE,
        operation: 'urn:dkg:workspace-operation:root-one',
        head: { shareOperationId: 'share-root-one' },
        operationShareOperationIds: ['share-root-one'],
      }),
      ...legacySwmBoundaryFixtureQuadsV1({
        graph: secondMetaGraph,
        contextGraphId: secondContextGraphId,
        ual: UAL_TWO,
        operation: 'urn:dkg:workspace-operation:root-two',
        head: { shareOperationId: 'share-root-two' },
        operationShareOperationIds: ['share-root-two'],
      }),
    ]);
    const querySpy = vi.spyOn(store, 'query');

    const owner = {};
    await initializeRfc64LegacySwmBoundaryV1(owner, root, store);

    expect(readRfc64LegacySwmBoundaryCountV1(
      owner,
      CONTEXT_GRAPH_ID,
    )).toBe(1);
    expect(readRfc64LegacySwmBoundaryCountV1(
      owner,
      secondContextGraphId,
    )).toBe(1);
    const headQueries = querySpy.mock.calls.filter(([, options]) => (
      options?.source === 'agent.rfc64.legacySwmBoundary.readHeads'
    )).map(([sparql]) => sparql);
    expect(headQueries).toHaveLength(1);
    expect(headQueries[0]).toContain('GRAPH ?metaGraph');
  });
});

async function secureTempRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dkg-rfc64-legacy-boundary-'));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function fakeStore(
  headsByGraph: Map<string, string[]>,
): TripleStore {
  return {
    listGraphs: vi.fn(async () => [...headsByGraph.keys()]),
    query: vi.fn(async (_sparql: string, options?: { source?: string }) => {
      const rootHeads = headsByGraph.get(META_GRAPH) ?? [];
      if (options?.source === 'agent.rfc64.legacySwmBoundary.readHeads') {
        return {
          type: 'bindings' as const,
          bindings: rootHeads.map((ual) => ({
            metaGraph: META_GRAPH,
            head: `${ual}#dkg-swm-head`,
            ual,
            contextGraphId: `"${CONTEXT_GRAPH_ID}"`,
          })),
        };
      }
      return { type: 'bindings' as const, bindings: [] };
    }),
  } as unknown as TripleStore;
}

function captureBinding(
  contextGraphId = CONTEXT_GRAPH_ID,
  ual = UAL_ONE,
): Record<string, string> {
  return {
    metaGraph: contextGraphWorkspaceMetaGraphUri(contextGraphId),
    head: `${ual}#dkg-swm-head`,
    ual,
    contextGraphId: JSON.stringify(contextGraphId),
  };
}

function scriptedCaptureStore(
  captureResult: QueryResult,
): TripleStore {
  const store = new OxigraphStore();
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.rfc64.legacySwmBoundary.readHeads') {
      return captureResult;
    }
    return query(sparql, options);
  });
  return store;
}

function testUal(kaNumber: number): string {
  return `did:dkg:otp:20430/0x1111111111111111111111111111111111111111/${kaNumber}`;
}
