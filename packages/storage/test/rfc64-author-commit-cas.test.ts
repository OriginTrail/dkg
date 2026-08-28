import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  BlazegraphStore,
  ChangelogStore,
  EXTERNAL_LITERAL_REF_DATATYPE,
  GraphSetIndexStore,
  OxigraphStore,
  RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1,
  RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1,
  RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1,
  SharedMemoryLiteralBlobStore,
  SparqlHttpStore,
  buildRfc64AuthorCommitCasUpdateV1,
  tryRfc64AuthorCommitCasV1,
  type Quad,
  type QueryOptions,
  type Rfc64AuthorCommitCasInputV1,
  type TripleStore,
} from '../src/index.js';

const PROJECTION_GRAPH = 'did:dkg:context-graph:rfc64/_shared_memory';
const SEAL_GRAPH = 'urn:test:rfc64:seals';
const HEAD_GRAPH = 'urn:test:rfc64:heads';
const STATE_GRAPH = 'urn:test:rfc64:state';
const OTHER_GRAPH = 'urn:test:rfc64:unrelated';
const AUTHOR = 'urn:test:rfc64:author:alice';
const SEAL = 'urn:test:rfc64:seal:alice';
const MUTATION = 'urn:test:rfc64:mutation:subgraph';
const APPLIED_SET = 'urn:test:rfc64:applied-set';
const P_VALUE = 'urn:test:rfc64:value';
const P_HEAD = 'urn:test:rfc64:current-head';
const P_GENERATION = 'urn:test:rfc64:generation';
const P_APPLIED = 'urn:test:rfc64:applied';
const OLD_HEAD = 'urn:test:rfc64:catalog:old';
const NEW_HEAD = 'urn:test:rfc64:catalog:new';

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

function authorCommitInput(
  overrides: Partial<Rfc64AuthorCommitCasInputV1> = {},
): Rfc64AuthorCommitCasInputV1 {
  return {
    sharedProjectionGraph: PROJECTION_GRAPH,
    sharedProjectionQuads: [
      quad('urn:test:rfc64:new:1', P_VALUE, '"new-1"', PROJECTION_GRAPH),
      quad('urn:test:rfc64:new:2', P_VALUE, '"new-2"', PROJECTION_GRAPH),
    ],
    authorSealGraph: SEAL_GRAPH,
    authorSealSubject: SEAL,
    authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', SEAL_GRAPH)],
    currentHeadGraph: HEAD_GRAPH,
    currentHeadSubject: AUTHOR,
    currentHeadPredicate: P_HEAD,
    expectedCurrentHeadObject: OLD_HEAD,
    nextCurrentHeadObject: NEW_HEAD,
    stateGuards: [
      {
        graphUri: STATE_GRAPH,
        subject: MUTATION,
        predicate: P_GENERATION,
        expectedObject: '"1"',
      },
      {
        graphUri: STATE_GRAPH,
        subject: APPLIED_SET,
        predicate: P_APPLIED,
        expectedObject: OLD_HEAD,
      },
    ],
    stateReplacements: [
      {
        graphUri: STATE_GRAPH,
        subject: MUTATION,
        quads: [quad(MUTATION, P_GENERATION, '"2"', STATE_GRAPH)],
      },
      {
        graphUri: STATE_GRAPH,
        subject: APPLIED_SET,
        quads: [quad(APPLIED_SET, P_APPLIED, NEW_HEAD, STATE_GRAPH)],
      },
    ],
    ...overrides,
  };
}

async function seedOldState(store: TripleStore): Promise<void> {
  await store.insert([
    quad('urn:test:rfc64:old', P_VALUE, '"old"', PROJECTION_GRAPH),
    quad(SEAL, P_VALUE, '"old-seal"', SEAL_GRAPH),
    quad(AUTHOR, P_HEAD, OLD_HEAD, HEAD_GRAPH),
    quad(MUTATION, P_GENERATION, '"1"', STATE_GRAPH),
    quad(APPLIED_SET, P_APPLIED, OLD_HEAD, STATE_GRAPH),
    quad('urn:test:rfc64:keep', P_VALUE, '"keep"', OTHER_GRAPH),
  ]);
}

async function objectFor(
  store: TripleStore,
  graph: string,
  subject: string,
  predicate: string,
): Promise<string | undefined> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings result');
  return result.bindings[0]?.o;
}

function overrideStore(base: TripleStore, overrides: Partial<TripleStore>): TripleStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}

describe('RFC-64 certified author commit CAS v1', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('commits the projection, seal, head, and bounded state old-or-new together', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');

    const projection = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${PROJECTION_GRAPH}> { ?s <${P_VALUE}> ?o } } ORDER BY ?s`,
    );
    expect(projection.type === 'bindings' ? projection.bindings : []).toEqual([
      { s: 'urn:test:rfc64:new:1', o: '"new-1"' },
      { s: 'urn:test:rfc64:new:2', o: '"new-2"' },
    ]);
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"2"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(NEW_HEAD);
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);
  });

  it('returns a clean conflict and changes no semantic target when any guard is stale', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const input = authorCommitInput({
      stateGuards: [{
        graphUri: STATE_GRAPH,
        subject: MUTATION,
        predicate: P_GENERATION,
        expectedObject: '"stale"',
      }],
    });

    await expect(store.rfc64AuthorCommitCasV1!(input)).resolves.toBe('conflict');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:old', P_VALUE)).toBe('"old"');
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"1"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);
  });

  it('allows exactly one of two writers to advance the same guarded head', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const first = authorCommitInput();
    const secondHead = 'urn:test:rfc64:catalog:competing';
    const second = authorCommitInput({
      nextCurrentHeadObject: secondHead,
      sharedProjectionQuads: [
        quad('urn:test:rfc64:competing', P_VALUE, '"competing"', PROJECTION_GRAPH),
      ],
      authorSealQuads: [quad(SEAL, P_VALUE, '"competing-seal"', SEAL_GRAPH)],
      stateReplacements: [
        {
          graphUri: STATE_GRAPH,
          subject: MUTATION,
          quads: [quad(MUTATION, P_GENERATION, '"3"', STATE_GRAPH)],
        },
        {
          graphUri: STATE_GRAPH,
          subject: APPLIED_SET,
          quads: [quad(APPLIED_SET, P_APPLIED, secondHead, STATE_GRAPH)],
        },
      ],
    });

    const results = await Promise.all([
      store.rfc64AuthorCommitCasV1!(first),
      store.rfc64AuthorCommitCasV1!(second),
    ]);
    expect(results.sort()).toEqual(['committed', 'conflict']);

    const head = await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD);
    if (head === NEW_HEAD) {
      expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
      expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"2"');
      expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(NEW_HEAD);
      expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:new:1', P_VALUE)).toBe('"new-1"');
    } else {
      expect(head).toBe(secondHead);
      expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"competing-seal"');
      expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"3"');
      expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(secondHead);
      expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:competing', P_VALUE)).toBe('"competing"');
    }
  });

  it('can atomically invalidate bounded state subjects without retracting the asset', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const input = authorCommitInput({
      stateReplacements: authorCommitInput().stateReplacements.map((replacement) => ({
        ...replacement,
        quads: [],
      })),
    });

    await expect(store.rfc64AuthorCommitCasV1!(input)).resolves.toBe('committed');
    expect(await store.countQuads(PROJECTION_GRAPH)).toBe(2);
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(NEW_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBeUndefined();
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBeUndefined();
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
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

  it('fails closed on unsupported and non-transactional endpoints before any request', async () => {
    const base = new OxigraphStore();
    const unsupported = overrideStore(base, { rfc64AuthorCommitCasV1: undefined });
    await expect(tryRfc64AuthorCommitCasV1(unsupported, authorCommitInput())).resolves.toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const remote = new SparqlHttpStore({ queryEndpoint: 'http://unsupported.invalid/sparql' });
    await expect(tryRfc64AuthorCommitCasV1(remote, authorCommitInput())).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['Blazegraph', () => new BlazegraphStore('http://rfc64.test/sparql') as TripleStore],
    ['transactional SPARQL HTTP', () => new SparqlHttpStore({
      queryEndpoint: 'http://rfc64.test/query',
      updateEndpoint: 'http://rfc64.test/update',
      atomicUpdates: true,
    }) as TripleStore],
  ])('uses the certified update and receipt protocol on %s', async (_name, createStore) => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(init?.body ?? '');
      requests.push({ url: String(input), body });
      if (body.includes('ASK')) {
        return new Response(JSON.stringify({ boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = createStore();

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');

    expect(requests).toHaveLength(3);
    expect(requests[0]!.body).toContain('urn:dkg:sync:authorCommitApplied');
    expect(requests[0]!.body).toContain(`GRAPH <${PROJECTION_GRAPH}>`);
    expect(requests[0]!.body).toContain(`GRAPH <${HEAD_GRAPH}>`);
    expect(requests[1]!.body).toContain('ASK');
    expect(requests[2]!.body).toContain('DROP SILENT GRAPH');
  });

  it('rejects ambiguous or unbounded fixed-manifest inputs before building an update', () => {
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealGraph: PROJECTION_GRAPH,
    }))).toThrow(/author seal cannot share/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      sharedProjectionQuads: [],
    }))).toThrow(/non-empty shared projection/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealQuads: [],
    }))).toThrow(/non-empty author seal/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealSubject: '_:seal',
    }))).toThrow(/canonical IRI/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      nextCurrentHeadObject: '_:next-head',
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateGuards: [{
        graphUri: STATE_GRAPH,
        subject: MUTATION,
        predicate: P_GENERATION,
        expectedObject: '_:generation',
      }],
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      expectedCurrentHeadObject: NEW_HEAD,
    }))).toThrow(/must advance/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      expectedCurrentHeadObject: `<${NEW_HEAD}>`,
    }))).toThrow(/must advance/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateGuards: Array.from(
        { length: RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1 + 1 },
        (_, index) => ({
          graphUri: STATE_GRAPH,
          subject: `urn:test:rfc64:guard:${index}`,
          predicate: P_VALUE,
          expectedObject: null,
        }),
      ),
    }))).toThrow(/at most .* state guards/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateReplacements: Array.from(
        { length: RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1 + 1 },
        (_, index) => ({
          graphUri: STATE_GRAPH,
          subject: `urn:test:rfc64:replacement:${index}`,
          quads: [],
        }),
      ),
    }))).toThrow(/at most .* state replacements/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateGuards: [
        authorCommitInput().stateGuards[0]!,
        authorCommitInput().stateGuards[0]!,
      ],
    }))).toThrow(/duplicate guard/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateGuards: [{
        graphUri: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}guard`,
        subject: MUTATION,
        predicate: P_GENERATION,
        expectedObject: '"1"',
      }],
    }))).toThrow(/internal atomic graph/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      stateReplacements: [
        authorCommitInput().stateReplacements[0]!,
        authorCommitInput().stateReplacements[0]!,
      ],
    }))).toThrow(/duplicate subject replacement/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      sharedProjectionGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}forbidden`,
      sharedProjectionQuads: [quad(
        'urn:test:rfc64:forbidden',
        P_VALUE,
        '"value"',
        `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}forbidden`,
      )],
    }))).toThrow(/internal atomic graph/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      authorSealQuads: Array.from(
        { length: RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1 },
        (_, index) => quad(SEAL, `urn:test:rfc64:seal-value:${index}`, '"value"', SEAL_GRAPH),
      ),
      stateReplacements: [],
    }))).toThrow(/control payload exceeds/i);
  });
});
