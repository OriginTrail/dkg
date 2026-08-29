import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  OxigraphStore,
  RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1,
  SparqlHttpStore,
  type Rfc64AuthorCommitCasInputV1,
} from '../src/index.js';
import {
  buildRfc64AuthorCommitCasUpdateV1,
  executeRfc64AuthorCommitCasV1,
  mapRfc64AuthorCommitCasV1,
  normalizeRfc64AuthorCommitCasV1,
} from '../src/rfc64-author-commit-cas.js';
import {
  APPLIED_SET,
  AUTHOR,
  CG_MUTATION,
  HEAD_GRAPH,
  INVALIDATED_SEAL,
  MUTATION,
  NEW_HEAD,
  OLD_HEAD,
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
  quad,
  seedOldState,
} from './rfc64-author-commit-cas-harness.js';

describe('RFC-64 certified author commit CAS v1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('receipt executor failure contract', () => {
    it('preserves an update failure when best-effort cleanup also fails', async () => {
      const updateError = new Error('update response lost');
      const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const readReceipt = vi.fn();
      const onCommitted = vi.fn();

      const error = await executeRfc64AuthorCommitCasV1({
        executeUpdate: () => { throw updateError; },
        readReceipt,
        cleanup,
        onCommitted,
      }).catch((reason: unknown) => reason);

      expect(error).toBe(updateError);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(readReceipt).not.toHaveBeenCalled();
      expect(onCommitted).not.toHaveBeenCalled();
    });

    it.each([
      ['receipt rejection', () => { throw new Error('receipt transport failed'); }],
      ['malformed receipt', () => ({ type: 'bindings', bindings: [] })],
    ])('preserves an indeterminate %s and still attempts cleanup', async (_name, read) => {
      const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      const onCommitted = vi.fn();

      const error = await executeRfc64AuthorCommitCasV1({
        executeUpdate: vi.fn(),
        readReceipt: read,
        cleanup,
        onCommitted,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/receipt (transport failed|query returned)/);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(onCommitted).not.toHaveBeenCalled();
    });

    it.each([
      [false, 'conflict', 0],
      [true, 'committed', 1],
    ] as const)(
      'keeps the %s receipt outcome when cleanup fails',
      async (receipt, expected, committedCalls) => {
        const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
        const onCommitted = vi.fn();

        await expect(executeRfc64AuthorCommitCasV1({
          executeUpdate: vi.fn(),
          readReceipt: () => receipt,
          cleanup,
          onCommitted,
        })).resolves.toBe(expected);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(onCommitted).toHaveBeenCalledTimes(committedCalls);
      },
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
    expect(await objectFor(store, STATE_GRAPH, CG_MUTATION, P_GENERATION)).toBe('"11"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(NEW_HEAD);
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);
  });

  it('maps every closed-manifest role through the canonical async plan', async () => {
    const input = authorCommitInput();
    const manifest = normalizeRfc64AuthorCommitCasV1(input);
    const quadRoles: string[] = [];
    const objectRoles: string[] = [];
    let mappedQuadIndex = 0;

    const mapped = await mapRfc64AuthorCommitCasV1(manifest, {
      mapQuad: async (value, context) => {
        quadRoles.push(`${context.role}:${context.roleIndex}`);
        return {
          ...value,
          object: `"mapped:${context.role}:${context.roleIndex}:${mappedQuadIndex++}"`,
        };
      },
      mapObject: async (value, context) => {
        objectRoles.push(`${context.role}:${context.kind}`);
        return value === null ? null : `<urn:test:mapped:${context.role}:${context.kind}>`;
      },
    });

    expect(quadRoles).toEqual([
      'sharedProjection:0',
      'sharedProjection:0',
      'authorSeal:0',
      'currentHead:0',
      'subgraphMutationGeneration:0',
      'contextGraphMutationGeneration:0',
      'appliedSet:0',
    ]);
    expect(objectRoles).toEqual([
      'currentHead:expected',
      'subgraphMutationGeneration:expected',
      'contextGraphMutationGeneration:expected',
      'appliedSet:expected',
    ]);
    expect(mapped.sharedProjectionQuads.map(({ object }) => object)).toEqual([
      '"mapped:sharedProjection:0:0"',
      '"mapped:sharedProjection:0:1"',
    ]);
    expect(mapped.authorSealQuads[0]?.object).toBe('"mapped:authorSeal:0:2"');
    expect(mapped.currentHead.quads[0]?.object).toBe('"mapped:currentHead:0:3"');
    expect(mapped.subgraphMutationGeneration.quads[0]?.object)
      .toBe('"mapped:subgraphMutationGeneration:0:4"');
    expect(mapped.contextGraphMutationGeneration.quads[0]?.object)
      .toBe('"mapped:contextGraphMutationGeneration:0:5"');
    expect(mapped.appliedSet.quads[0]?.object).toBe('"mapped:appliedSet:0:6"');
    expect(mapped.currentHead.expectedObject).toBe('<urn:test:mapped:currentHead:expected>');
    expect(mapped.subgraphMutationGeneration.expectedObject)
      .toBe('<urn:test:mapped:subgraphMutationGeneration:expected>');
    expect(mapped.contextGraphMutationGeneration.expectedObject)
      .toBe('<urn:test:mapped:contextGraphMutationGeneration:expected>');
    expect(mapped.appliedSet.expectedObject).toBe('<urn:test:mapped:appliedSet:expected>');
    expect(manifest.semanticQuads).toHaveLength(7);
    expect(manifest.touchedGraphs).toEqual([
      PROJECTION_GRAPH,
      SEAL_GRAPH,
      HEAD_GRAPH,
      STATE_GRAPH,
    ]);
    expect(manifest.referencedGraphs).toEqual(manifest.touchedGraphs);
  });

  it('returns a clean conflict and changes no semantic target when any guard is stale', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const base = authorCommitInput();
    const input = authorCommitInput({
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        expectedObject: '"stale"',
      },
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

  it('honors Oxigraph pre-dispatch cancellation without changing any semantic target', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled before CAS dispatch'));

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput(), {
      signal: controller.signal,
    })).rejects.toThrow('caller cancelled before CAS dispatch');

    expect(await objectFor(store, PROJECTION_GRAPH, 'urn:test:rfc64:old', P_VALUE)).toBe('"old"');
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBe('"1"');
    expect(await objectFor(store, STATE_GRAPH, CG_MUTATION, P_GENERATION)).toBe('"10"');
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
  });

  it('rejects an oversized non-SWM current-head literal before remote dispatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://oversized-head.test/query',
      updateEndpoint: 'http://oversized-head.test/update',
      consistencyProfile: 'atomic-readback',
    });

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput({
      currentHead: {
        ...authorCommitInput().currentHead,
        quads: [quad(AUTHOR, P_HEAD, `"${'x'.repeat(65_536)}"`, HEAD_GRAPH)],
      },
    }))).rejects.toThrow(/safe limit of 65535 bytes/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enforces exact-value and absent-value guard semantics', async () => {
    const multiValued = new OxigraphStore();
    await seedOldState(multiValued);
    await multiValued.insert([
      quad(MUTATION, P_GENERATION, '"unexpected"', STATE_GRAPH),
    ]);
    await expect(multiValued.rfc64AuthorCommitCasV1!(authorCommitInput()))
      .resolves.toBe('conflict');
    expect(await objectFor(multiValued, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(multiValued, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(
      multiValued,
      PROJECTION_GRAPH,
      'urn:test:rfc64:old',
      P_VALUE,
    )).toBe('"old"');
    expect(await objectFor(multiValued, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);

    const absent = new OxigraphStore();
    await seedOldState(absent);
    await absent.delete([quad(AUTHOR, P_HEAD, OLD_HEAD, HEAD_GRAPH)]);
    const base = authorCommitInput();
    const absentInput = authorCommitInput({
      currentHead: {
        ...base.currentHead,
        expectedObject: null,
      },
    });
    await expect(absent.rfc64AuthorCommitCasV1!(absentInput)).resolves.toBe('committed');

    const present = new OxigraphStore();
    await seedOldState(present);
    await expect(present.rfc64AuthorCommitCasV1!(absentInput)).resolves.toBe('conflict');
    expect(await objectFor(present, HEAD_GRAPH, AUTHOR, P_HEAD)).toBe(OLD_HEAD);
    expect(await objectFor(present, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"old-seal"');
    expect(await objectFor(
      present,
      PROJECTION_GRAPH,
      'urn:test:rfc64:old',
      P_VALUE,
    )).toBe('"old"');
    expect(await objectFor(present, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBe(OLD_HEAD);
  });

  it('rejects the second of two serial writers that use the same guarded head', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const first = authorCommitInput();
    const secondHead = 'urn:test:rfc64:catalog:competing';
    const second = authorCommitInput({
      currentHead: {
        ...authorCommitInput().currentHead,
        quads: [quad(AUTHOR, P_HEAD, secondHead, HEAD_GRAPH)],
      },
      sharedProjectionQuads: [
        quad('urn:test:rfc64:competing', P_VALUE, '"competing"', PROJECTION_GRAPH),
      ],
      authorSealQuads: [quad(SEAL, P_VALUE, '"competing-seal"', SEAL_GRAPH)],
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        quads: [quad(MUTATION, P_GENERATION, '"3"', STATE_GRAPH)],
      },
      contextGraphMutationGeneration: {
        ...authorCommitInput().contextGraphMutationGeneration,
        quads: [quad(CG_MUTATION, P_GENERATION, '"12"', STATE_GRAPH)],
      },
      appliedSet: {
        ...authorCommitInput().appliedSet,
        quads: [quad(APPLIED_SET, P_APPLIED, secondHead, STATE_GRAPH)],
      },
    });

    const results = [
      await store.rfc64AuthorCommitCasV1!(first),
      await store.rfc64AuthorCommitCasV1!(second),
    ];
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

  it('can atomically clear the four bounded control subjects without retracting the asset', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const base = authorCommitInput();
    const input = authorCommitInput({
      currentHead: { ...base.currentHead, quads: [] },
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        quads: [],
      },
      contextGraphMutationGeneration: {
        ...base.contextGraphMutationGeneration,
        quads: [],
      },
      appliedSet: {
        ...base.appliedSet,
        quads: [],
      },
    });

    await expect(store.rfc64AuthorCommitCasV1!(input)).resolves.toBe('committed');
    expect(await store.countQuads(PROJECTION_GRAPH)).toBe(2);
    expect(await objectFor(store, SEAL_GRAPH, SEAL, P_VALUE)).toBe('"new-seal"');
    expect(await objectFor(store, HEAD_GRAPH, AUTHOR, P_HEAD)).toBeUndefined();
    expect(await objectFor(store, STATE_GRAPH, MUTATION, P_GENERATION)).toBeUndefined();
    expect(await objectFor(store, STATE_GRAPH, APPLIED_SET, P_APPLIED)).toBeUndefined();
    expect(await store.countQuads(OTHER_GRAPH)).toBe(1);
  });

  it('retains unrelated stale seals on both commit and conflict', async () => {
    const committed = new OxigraphStore();
    await seedOldState(committed);
    await committed.insert([
      quad(INVALIDATED_SEAL, P_VALUE, '"stale-seal"', SEAL_GRAPH),
    ]);
    await expect(committed.rfc64AuthorCommitCasV1!(authorCommitInput()))
      .resolves.toBe('committed');
    expect(await objectFor(committed, SEAL_GRAPH, INVALIDATED_SEAL, P_VALUE))
      .toBe('"stale-seal"');

    const conflicted = new OxigraphStore();
    await seedOldState(conflicted);
    await conflicted.insert([
      quad(INVALIDATED_SEAL, P_VALUE, '"stale-seal"', SEAL_GRAPH),
    ]);
    const base = authorCommitInput();
    await expect(conflicted.rfc64AuthorCommitCasV1!(authorCommitInput({
      subgraphMutationGeneration: {
        ...base.subgraphMutationGeneration,
        expectedObject: '"stale"',
      },
    }))).resolves.toBe('conflict');
    expect(await objectFor(conflicted, SEAL_GRAPH, INVALIDATED_SEAL, P_VALUE)).toBe('"stale-seal"');
  });

  it('bumps affected write generations only for a committed CAS', async () => {
    const store = new OxigraphStore();
    await seedOldState(store);
    const affectedPrefix = 'did:dkg:context-graph:rfc64/';
    const unrelatedPrefix = 'did:dkg:context-graph:unrelated/';
    const affectedBefore = store.getWriteGen(affectedPrefix);
    const unrelatedBefore = store.getWriteGen(unrelatedPrefix);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');
    const affectedAfterCommit = store.getWriteGen(affectedPrefix);
    expect(affectedAfterCommit).toBeGreaterThan(affectedBefore);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('conflict');
    expect(store.getWriteGen(affectedPrefix)).toBe(affectedAfterCommit);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);
  });

  it('keeps remote semantic write generations stable on a clean conflict', async () => {
    let receiptValue = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (String(init?.body ?? '').includes('ASK')) {
        return new Response(JSON.stringify({ boolean: receiptValue }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://write-gen.test/query',
      updateEndpoint: 'http://write-gen.test/update',
      consistencyProfile: 'atomic-readback',
    });
    const affectedPrefix = 'did:dkg:context-graph:rfc64/';
    const unrelatedPrefix = 'did:dkg:context-graph:unrelated/';
    const affectedBefore = store.getWriteGen(affectedPrefix);
    const unrelatedBefore = store.getWriteGen(unrelatedPrefix);

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).resolves.toBe('committed');
    const affectedAfterCommit = store.getWriteGen(affectedPrefix);
    expect(affectedAfterCommit).toBeGreaterThan(affectedBefore);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);

    receiptValue = false;
    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput())).resolves.toBe('conflict');
    expect(store.getWriteGen(affectedPrefix)).toBe(affectedAfterCommit);
    expect(store.getWriteGen(unrelatedPrefix)).toBe(unrelatedBefore);
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
      currentHead: {
        ...authorCommitInput().currentHead,
        expectedObject: '_:next-head',
      },
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        expectedObject: '_:generation',
      },
    }))).toThrow(/blank node/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1({
      ...authorCommitInput(),
      currentHead: undefined,
    } as unknown as Rfc64AuthorCommitCasInputV1)).toThrow(/exact currentHead semantic transition/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      appliedSet: {
        ...authorCommitInput().appliedSet,
        graphUri: authorCommitInput().currentHead.graphUri,
        subject: authorCommitInput().currentHead.subject,
        predicate: authorCommitInput().currentHead.predicate,
      },
    }))).toThrow(/duplicate guard/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      subgraphMutationGeneration: {
        ...authorCommitInput().subgraphMutationGeneration,
        graphUri: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}guard`,
      },
    }))).toThrow(/internal atomic graph/i);
    expect(() => buildRfc64AuthorCommitCasUpdateV1(authorCommitInput({
      appliedSet: {
        ...authorCommitInput().appliedSet,
        graphUri: authorCommitInput().currentHead.graphUri,
        subject: authorCommitInput().currentHead.subject,
        predicate: P_APPLIED,
      },
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
    }))).toThrow(/control payload exceeds/i);
  });
});
