import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangelogStore,
  EXTERNAL_LITERAL_REF_DATATYPE,
  GraphSetIndexStore,
  OxigraphStore,
  SharedMemoryLiteralBlobStore,
  UnsupportedTripleStoreCapabilityError,
  createTripleStore,
  tryRfc64AuthorCommitCasV1,
  type QueryOptions,
  type Rfc64AuthorCommitCasInputV1,
} from '../src/index.js';
import {
  APPLIED_SET,
  AUTHOR,
  CG_MUTATION,
  HEAD_GRAPH,
  INVALIDATED_SEAL,
  KA_STATE,
  MUTATION,
  NEW_HEAD,
  OTHER_GRAPH,
  PROJECTION_GRAPH,
  P_APPLIED,
  P_GENERATION,
  P_HEAD,
  P_VALUE,
  SEAL,
  SEAL_GRAPH,
  STATE_GRAPH,
  authorCommitInput,
  objectFor,
  overrideStore,
  quad,
  seedOldState,
} from './rfc64-author-commit-cas-harness.js';

describe('RFC-64 author commit decorator integration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('preserves the capability through literal, graph-index, and changelog decorators', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-author-commit-blobs-'));
    tempDirs.push(blobDir);
    const raw = new OxigraphStore();
    const blobs = new SharedMemoryLiteralBlobStore(raw, { blobDir, thresholdBytes: 20 });
    const indexed = new GraphSetIndexStore(blobs, { revalidateMs: 60_000 });
    const records: Array<{ graph: string; op: string }> = [];
    const store = new ChangelogStore(indexed, {
      onAppend: ({ graph, op }) => records.push({ graph, op }),
    });
    await seedOldState(store);
    records.length = 0;
    const largeLiteral = `"${'large-public-swm-value'.repeat(10)}"`;

    await expect(tryRfc64AuthorCommitCasV1(store, authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:new:large', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('committed');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:new:large', P_VALUE)).toBe(
      largeLiteral,
    );
    const rawObject = await objectFor(
      raw,
      PROJECTION_GRAPH,
      'urn:test:rfc64:new:large',
      P_VALUE,
    );
    expect(rawObject).toMatch(
      new RegExp(`^"sha256:[0-9a-f]{64}"\\^\\^<${EXTERNAL_LITERAL_REF_DATATYPE}>$`),
    );
    expect(records).toEqual([
      { graph: PROJECTION_GRAPH, op: 'upsert' },
      { graph: SEAL_GRAPH, op: 'upsert' },
      { graph: HEAD_GRAPH, op: 'upsert' },
      { graph: STATE_GRAPH, op: 'upsert' },
    ]);
    expect(await store.listGraphs()).toEqual(expect.arrayContaining([
      PROJECTION_GRAPH,
      SEAL_GRAPH,
      HEAD_GRAPH,
      STATE_GRAPH,
    ]));

    records.length = 0;
    await expect(tryRfc64AuthorCommitCasV1(store, authorCommitInput())).resolves.toBe('conflict');
    expect(records).toEqual([]);
  });

  it('commits one consistent winner and persists it through the factory worker stack', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-author-commit-worker-'));
    tempDirs.push(dataDir);
    const path = join(dataDir, 'store.nq');
    const first = authorCommitInput();
    const competingHead = 'urn:test:rfc64:catalog:competing';
    const competingProjection = 'urn:test:rfc64:new:competing';
    const second = authorCommitInput({
      sharedProjectionQuads: [quad(competingProjection, P_VALUE, '"competing"', PROJECTION_GRAPH)],
      authorSealQuads: [quad(SEAL, P_VALUE, '"competing-seal"', SEAL_GRAPH)],
      nextCurrentHeadObject: competingHead,
      kaStateDigest: {
        ...first.kaStateDigest,
        quads: [quad(KA_STATE, P_VALUE, competingHead, STATE_GRAPH)],
      },
      subgraphMutationGeneration: {
        ...first.subgraphMutationGeneration,
        quads: [quad(MUTATION, P_GENERATION, '"3"', STATE_GRAPH)],
      },
      contextGraphMutationGeneration: {
        ...first.contextGraphMutationGeneration,
        quads: [quad(CG_MUTATION, P_GENERATION, '"12"', STATE_GRAPH)],
      },
      appliedSet: {
        ...first.appliedSet,
        quads: [quad(APPLIED_SET, P_APPLIED, competingHead, STATE_GRAPH)],
      },
    });

    let store = await createTripleStore({ backend: 'oxigraph-worker', options: { path } });
    await seedOldState(store);
    const results = await Promise.all([
      tryRfc64AuthorCommitCasV1(store, first),
      tryRfc64AuthorCommitCasV1(store, second),
    ]);
    expect(results.slice().sort()).toEqual(['committed', 'conflict']);
    const winner = results[0] === 'committed'
      ? {
          head: NEW_HEAD,
          projectionSubject: 'urn:test:rfc64:new:1',
          projectionValue: '"new-1"',
          losingProjectionSubject: competingProjection,
          seal: '"new-seal"',
          mutation: '"2"',
          contextMutation: '"11"',
        }
      : {
          head: competingHead,
          projectionSubject: competingProjection,
          projectionValue: '"competing"',
          losingProjectionSubject: 'urn:test:rfc64:new:1',
          seal: '"competing-seal"',
          mutation: '"3"',
          contextMutation: '"12"',
        };

    const assertWinner = async () => {
      expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(winner.head);
      expect(await objectFor(store, PROJECTION_GRAPH, winner.projectionSubject, P_VALUE))
        .toBe(winner.projectionValue);
      expect(await objectFor(store, PROJECTION_GRAPH, winner.losingProjectionSubject, P_VALUE))
        .toBeUndefined();
      expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe(winner.seal);
      expect(await objectFor(store, STATE_GRAPH, KA_STATE, P_VALUE)).toBe(winner.head);
      expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe(winner.mutation);
      expect(await objectFor(store, STATE_GRAPH, CG_MUTATION, P_GENERATION))
        .toBe(winner.contextMutation);
      expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(winner.head);
    };
    await assertWinner();
    await store.flush();
    await store.close();

    store = await createTripleStore({ backend: 'oxigraph-worker', options: { path } });
    try {
      await assertWinner();
    } finally {
      await store.close();
    }
  }, 15_000);

  it('flags changelog reconciliation after an indeterminate post-commit failure', async () => {
    const base = new OxigraphStore();
    await seedOldState(base);
    const inner = overrideStore(base, {
      rfc64AuthorCommitCasV1: async (
        input: Rfc64AuthorCommitCasInputV1,
        options?: QueryOptions,
      ) => {
        await base.rfc64AuthorCommitCasV1!(input, options);
        throw new Error('response lost after commit');
      },
    });
    const store = new ChangelogStore(inner);

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).rejects.toThrow(
      'response lost after commit',
    );
    expect(store.needsReconcile).toBe(true);
    expect(await objectFor(base, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
  });

  it('rebuilds a warm graph index after an indeterminate RFC-64 commit response', async () => {
    const base = new OxigraphStore();
    await seedOldState(base);
    const committedGraph = 'urn:test:rfc64:new-seal-graph';
    const committedInput = authorCommitInput({
      authorSealGraph: committedGraph,
      authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', committedGraph)],
    });
    let scans = 0;
    const inner = overrideStore(base, {
      listGraphs: async (options?: QueryOptions) => {
        scans += 1;
        return base.listGraphs(options);
      },
      rfc64AuthorCommitCasV1: async (input, options) => {
        await base.rfc64AuthorCommitCasV1!(input, options);
        throw new Error('RFC-64 response lost after commit');
      },
    });
    const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
    expect(await store.listGraphs()).not.toContain(committedGraph);
    expect(scans).toBe(1);

    await expect(store.rfc64AuthorCommitCasV1(committedInput))
      .rejects.toThrow('RFC-64 response lost after commit');
    expect(await store.listGraphs()).toEqual(expect.arrayContaining([
      PROJECTION_GRAPH,
      committedGraph,
      HEAD_GRAPH,
      STATE_GRAPH,
    ]));
    expect(scans).toBe(2);
  });

  it('maintains added and emptied graphs in a warm index without a full rescan', async () => {
    const base = new OxigraphStore();
    await seedOldState(base);
    const addedGraph = 'urn:test:rfc64:added-seal-graph';
    const emptiedGraph = 'urn:test:rfc64:emptied-seal-graph';
    await base.insert([
      quad(INVALIDATED_SEAL, P_VALUE, '"stale-seal"', emptiedGraph),
    ]);
    let scans = 0;
    const inner = overrideStore(base, {
      listGraphs: async (options?: QueryOptions) => {
        scans += 1;
        return base.listGraphs(options);
      },
    });
    const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
    expect(await store.listGraphs()).toEqual(expect.arrayContaining([emptiedGraph]));
    expect(await store.listGraphs()).not.toContain(addedGraph);
    expect(scans).toBe(1);

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput({
      authorSealGraph: addedGraph,
      authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', addedGraph)],
      sealInvalidations: [{
        graphUri: emptiedGraph,
        subject: INVALIDATED_SEAL,
        quads: [],
      }],
    }))).resolves.toBe('committed');

    const graphs = await store.listGraphs();
    expect(graphs).toContain(addedGraph);
    expect(graphs).not.toContain(emptiedGraph);
    expect(scans).toBe(1);
  });

  it('rejects invalid author-commit metadata before a permissive inner store is dispatched', async () => {
    const base = new OxigraphStore();
    let dispatches = 0;
    const inner = overrideStore(base, {
      rfc64AuthorCommitCasV1: async () => {
        dispatches += 1;
        return 'committed';
      },
    });
    const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
    const invalidInput = {
      ...authorCommitInput(),
      sharedProjectionGraph: undefined,
    } as unknown as Rfc64AuthorCommitCasInputV1;

    await expect(store.rfc64AuthorCommitCasV1(invalidInput)).rejects.toThrow();
    expect(dispatches).toBe(0);
  });

  it('keeps a warm graph index on RFC-64 conflict and proven not-started refusal', async () => {
    for (const outcome of ['conflict', 'not-started'] as const) {
      const base = new OxigraphStore();
      await base.insert([quad('urn:test:rfc64:warm', P_VALUE, '"warm"', OTHER_GRAPH)]);
      let scans = 0;
      const inner = overrideStore(base, {
        listGraphs: async (options?: QueryOptions) => {
          scans += 1;
          return base.listGraphs(options);
        },
        rfc64AuthorCommitCasV1: async () => {
          if (outcome === 'not-started') {
            throw new UnsupportedTripleStoreCapabilityError(
              'rfc64AuthorCommitCasV1',
              'refusing-test-store',
            );
          }
          return 'conflict';
        },
      });
      const store = new GraphSetIndexStore(inner, { revalidateMs: 60_000 });
      expect(await store.listGraphs()).toEqual([OTHER_GRAPH]);
      expect(scans).toBe(1);

      if (outcome === 'conflict') {
        await expect(store.rfc64AuthorCommitCasV1(authorCommitInput()))
          .resolves.toBe('conflict');
      } else {
        await expect(store.rfc64AuthorCommitCasV1(authorCommitInput()))
          .rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
      }
      expect(await store.listGraphs()).toEqual([OTHER_GRAPH]);
      expect(scans).toBe(1);
    }
  });
});
