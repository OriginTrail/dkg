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
  tryRfc64AuthorCommitCasV1,
  type QueryOptions,
  type Rfc64AuthorCommitCasInputV1,
} from '../src/index.js';
import {
  AUTHOR,
  HEAD_GRAPH,
  INVALIDATED_SEAL,
  NEW_HEAD,
  OTHER_GRAPH,
  PROJECTION_GRAPH,
  P_HEAD,
  P_VALUE,
  SEAL,
  SEAL_GRAPH,
  STATE_GRAPH,
  authorCommitInput,
  legacyAuthorCommitInput,
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

  it('preserves the legacy public input shape behind every decorator', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-legacy-decorator-blobs-'));
    tempDirs.push(blobDir);
    const base = new OxigraphStore();
    const received: Rfc64AuthorCommitCasInputV1[] = [];
    const legacyOnly = overrideStore(base, {
      rfc64AuthorCommitCasV1: async (input) => {
        received.push(input);
        if (!('currentHeadGraph' in input) || 'planKind' in input) {
          throw new Error('legacy-only adapter received an internal plan');
        }
        return 'conflict';
      },
    });
    const wrappers = [
      new ChangelogStore(legacyOnly),
      new GraphSetIndexStore(legacyOnly, { revalidateMs: 60_000 }),
      new SharedMemoryLiteralBlobStore(legacyOnly, {
        blobDir,
        thresholdBytes: Number.MAX_SAFE_INTEGER,
      }),
    ];

    for (const store of wrappers) {
      await expect(store.rfc64AuthorCommitCasV1(legacyAuthorCommitInput()))
        .resolves.toBe('conflict');
    }
    expect(received).toHaveLength(3);
    expect(received.every((input) => 'currentHeadGraph' in input)).toBe(true);
    await base.close();
  });

  it('snapshots a queued changelog commit before caller mutation', async () => {
    const base = new OxigraphStore();
    let releaseInsert!: () => void;
    let insertEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const entered = new Promise<void>((resolve) => { insertEntered = resolve; });
    let blockInsert = true;
    let received: Rfc64AuthorCommitCasInputV1 | undefined;
    const inner = overrideStore(base, {
      insert: async (quads, options) => {
        if (blockInsert) {
          blockInsert = false;
          insertEntered();
          await release;
        }
        return base.insert(quads, options);
      },
      rfc64AuthorCommitCasV1: async (input) => {
        received = input;
        return 'conflict';
      },
    });
    const store = new ChangelogStore(inner);
    const blocker = store.insert([
      quad('urn:test:rfc64:queue-blocker', P_VALUE, '"block"', OTHER_GRAPH),
    ]);
    await entered;

    const mutable = legacyAuthorCommitInput();
    const expectedSealGraph = mutable.authorSealGraph;
    const expectedSealObject = mutable.authorSealQuads[0]!.object;
    const commit = store.rfc64AuthorCommitCasV1(mutable);
    (mutable as { authorSealGraph: string }).authorSealGraph = 'urn:test:rfc64:mutated';
    (mutable.authorSealQuads[0] as { object: string }).object = '"mutated"';
    releaseInsert();

    await blocker;
    await expect(commit).resolves.toBe('conflict');
    expect(received).toBeDefined();
    expect(received && 'planKind' in received).toBe(false);
    expect(received && 'currentHeadGraph' in received ? received.authorSealGraph : undefined)
      .toBe(expectedSealGraph);
    expect(received && 'currentHeadGraph' in received
      ? received.authorSealQuads[0]?.object
      : undefined).toBe(expectedSealObject);
    await base.close();
  });

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

  it('maintains an added graph and retains an unrelated stale-seal graph without a full rescan', async () => {
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
    }))).resolves.toBe('committed');

    const graphs = await store.listGraphs();
    expect(graphs).toContain(addedGraph);
    expect(graphs).toContain(emptiedGraph);
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
