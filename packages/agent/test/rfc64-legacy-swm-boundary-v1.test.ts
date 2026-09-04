// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  contextGraphSharedMemoryMetaUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeRfc64LegacySwmBoundaryV1,
  prepareRfc64LateLegacySwmBoundaryV1,
  markRfc64LegacySwmRepublishedV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

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
    expect(store.listGraphs).toHaveBeenCalledTimes(1);
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
    const store = fakeStore(new Map([[META_GRAPH, [UAL_ONE]]]), `${UAL_TWO}#dkg-swm-head`);

    await expect(initializeRfc64LegacySwmBoundaryV1({}, root, store)).rejects.toThrow(
      `RFC-64 legacy SWM head identity differs for ${UAL_ONE}`,
    );
  });

  it('captures only the exact root when root and named-subgraph heads coexist', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    await store.insert([
      ...legacyHeadQuads(META_GRAPH, UAL_ONE, 'root'),
      ...legacyHeadQuads(SUBGRAPH_META_GRAPH, UAL_TWO, 'named'),
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

  it('captures only fully joined legacy heads through the real Oxigraph query', async () => {
    const root = await secureTempRoot(roots);
    const store = new OxigraphStore();
    const correctHead = `${UAL_ONE}#dkg-swm-head`;
    const mismatchedHead = `${UAL_TWO}#dkg-swm-head`;
    await store.insert([
      { graph: META_GRAPH, subject: correctHead, predicate: 'http://dkg.io/ontology/kaUal', object: UAL_ONE },
      { graph: META_GRAPH, subject: correctHead, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"share-one"' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:one', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:one', predicate: 'http://dkg.io/ontology/kaUal', object: UAL_ONE },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:one', predicate: 'http://dkg.io/ontology/shareOperationId', object: '"share-one"' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:one', predicate: 'http://dkg.io/ontology/contextGraphId', object: `"${CONTEXT_GRAPH_ID}"` },
      // This head looks plausible but its operation carries another share id,
      // so the production join must not classify it as a captured legacy row.
      { graph: META_GRAPH, subject: mismatchedHead, predicate: 'http://dkg.io/ontology/kaUal', object: UAL_TWO },
      { graph: META_GRAPH, subject: mismatchedHead, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"share-two"' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:two', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:two', predicate: 'http://dkg.io/ontology/kaUal', object: UAL_TWO },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:two', predicate: 'http://dkg.io/ontology/shareOperationId', object: '"different-share"' },
      { graph: META_GRAPH, subject: 'urn:dkg:workspace-operation:two', predicate: 'http://dkg.io/ontology/contextGraphId', object: `"${CONTEXT_GRAPH_ID}"` },
    ]);

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
});

async function secureTempRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dkg-rfc64-legacy-boundary-'));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function fakeStore(
  headsByGraph: Map<string, string[]>,
  forcedHead?: string,
): TripleStore {
  return {
    listGraphs: vi.fn(async () => [...headsByGraph.keys()]),
    query: vi.fn(async (sparql: string) => {
      const graph = [...headsByGraph.keys()].find((candidate) => (
        sparql.includes(`GRAPH <${candidate}>`)
      ));
      return {
        type: 'bindings' as const,
        bindings: (graph === undefined ? [] : headsByGraph.get(graph) ?? []).map((ual) => ({
          head: forcedHead ?? `${ual}#dkg-swm-head`,
          ual,
          contextGraphId: `"${CONTEXT_GRAPH_ID}"`,
        })),
      };
    }),
  } as unknown as TripleStore;
}

function legacyHeadQuads(graph: string, ual: string, id: string) {
  const head = `${ual}#dkg-swm-head`;
  const operation = `urn:dkg:workspace-operation:${id}`;
  const shareId = `"share-${id}"`;
  return [
    { graph, subject: head, predicate: 'http://dkg.io/ontology/kaUal', object: ual },
    { graph, subject: head, predicate: 'http://dkg.io/ontology/shareOperationId', object: shareId },
    { graph, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
    { graph, subject: operation, predicate: 'http://dkg.io/ontology/kaUal', object: ual },
    { graph, subject: operation, predicate: 'http://dkg.io/ontology/shareOperationId', object: shareId },
    { graph, subject: operation, predicate: 'http://dkg.io/ontology/contextGraphId', object: `"${CONTEXT_GRAPH_ID}"` },
  ];
}
