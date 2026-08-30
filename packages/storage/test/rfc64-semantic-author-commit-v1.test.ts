import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ASSERTION_SEAL_PREDICATES,
  deriveRfc64SharedProjectionGraphIriV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  projectCanonicalGraphScopedAuthorSealRowsV1,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type Rfc64SemanticRecordCoordinateV1,
  type Rfc64SemanticRecordV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';

import {
  OxigraphStore,
  OxigraphWorkerStore,
  Rfc64SemanticAuthorCommitErrorV1,
  SyncSemanticStoreV1,
  compileRfc64SemanticAuthorCommitV1,
  type Quad,
  type Rfc64SemanticAuthorCommitInputV1,
} from '../src/index.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH = (
  '0x0123456789abcdef0123456789abcdef01234567/14'
) as ContextGraphIdV1;
const SUBGRAPH = 'research' as SubGraphNameV1;
const AUTHOR = '0x89abcdef0123456789abcdef0123456789abcdef' as EvmAddressV1;
const DIGEST_A = `0x${'a'.repeat(64)}` as Digest32V1;
const DIGEST_B = `0x${'b'.repeat(64)}` as Digest32V1;
const DIGEST_C = `0x${'c'.repeat(64)}` as Digest32V1;
const DIGEST_D = `0x${'d'.repeat(64)}` as Digest32V1;
const KA_NUMBER = '7';
const PROJECTION_GRAPH = deriveRfc64SharedProjectionGraphIriV1(
  { contextGraphId: CONTEXT_GRAPH, subGraphName: SUBGRAPH },
  `did:dkg:${NETWORK}/${AUTHOR}/${KA_NUMBER}`,
);
const SEAL_COORDINATE = Object.freeze({
  contextGraphId: CONTEXT_GRAPH,
  subGraphName: SUBGRAPH,
  authorAddress: AUTHOR,
  assertionCoordinate: 'research-note',
}) as CanonicalGraphScopedAuthorSealCoordinateV1;
const SEAL_PLACEMENT = deriveCanonicalGraphScopedAuthorSealPlacementV1(SEAL_COORDINATE);
const SEAL_GRAPH = SEAL_PLACEMENT.metaGraph;
const SEAL_SUBJECT = SEAL_PLACEMENT.subject;
const AUTHOR_SEAL = Object.freeze({
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
  assertionFinalizedAt: '2026-08-29T10:00:00.123Z',
  assertionMerkleRoot: `0x${'e'.repeat(64)}`,
  assertionVersion: '1',
  authorAddress: AUTHOR,
  authorAttestationR: `0x${'1'.repeat(64)}`,
  authorAttestationVS: `0x${'2'.repeat(64)}`,
  authorSchemeVersion: '1',
  contentScopeVersion: '2',
  kaUal: `did:dkg:${NETWORK}/${AUTHOR}/${KA_NUMBER}`,
  privateMerkleRoot: null,
  privateTripleCount: '0',
  publicTripleCount: '1',
  reservedKaId: ((BigInt(AUTHOR) << 96n) | BigInt(KA_NUMBER)).toString(),
}) as CanonicalGraphScopedAuthorSealV1;

const EXPECTED_HEAD = record('CurrentAuthorCatalogRefV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: SUBGRAPH,
  authorAddress: AUTHOR,
  catalogEra: '1',
  catalogVersion: '4',
  catalogHeadDigest: DIGEST_A,
});
const NEXT_HEAD = record('CurrentAuthorCatalogRefV1', {
  ...EXPECTED_HEAD.value,
  catalogVersion: '5',
  catalogHeadDigest: DIGEST_B,
});
const EXPECTED_SUBGRAPH_MUTATION = record('SubgraphMutationGuardV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  subGraphName: SUBGRAPH,
  generation: '4',
});
const NEXT_SUBGRAPH_MUTATION = record('SubgraphMutationGuardV1', {
  ...EXPECTED_SUBGRAPH_MUTATION.value,
  generation: '5',
});
const EXPECTED_CG_MUTATION = record('ContextGraphMutationGuardV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  generation: '8',
});
const NEXT_CG_MUTATION = record('ContextGraphMutationGuardV1', {
  ...EXPECTED_CG_MUTATION.value,
  generation: '9',
});
const EXPECTED_APPLIED_SET = record('AppliedSubgraphSetRefV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  generation: '8',
  subgraphIndexEra: '1',
  subgraphIndexVersion: '3',
  subgraphCount: '1',
  appliedDirectoryRootDigest: DIGEST_C,
});
const NEXT_APPLIED_SET = record('AppliedSubgraphSetRefV1', {
  ...EXPECTED_APPLIED_SET.value,
  generation: '9',
  appliedDirectoryRootDigest: DIGEST_D,
});
const STALE_SUBGRAPH_SEAL = record('AppliedSubgraphSealV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  subGraphName: SUBGRAPH,
  checkpointEra: '1',
  checkpointVersion: '3',
  checkpointDigest: DIGEST_C,
  mutationGeneration: '4',
  appliedAt: '2026-08-29T10:00:00.123Z',
});
const STALE_CG_SEAL = record('AppliedContextGraphSealV1', {
  networkId: NETWORK,
  contextGraphId: CONTEXT_GRAPH,
  checkpointEra: '1',
  checkpointVersion: '3',
  checkpointDigest: DIGEST_C,
  policyDigest: DIGEST_A,
  chainCoverageDigest: DIGEST_D,
  mutationGeneration: '8',
  appliedAt: '2026-08-29T10:00:00.123Z',
});

describe('RFC-64 typed semantic author commit v1', () => {
  it('compiles complete canonical semantic subjects and no obsolete mutation knobs', () => {
    const compiled = compileRfc64SemanticAuthorCommitV1(commitInput());
    expect(compiled.currentHead.quads).toHaveLength(10);
    expect(compiled.subgraphMutationGeneration.quads).toHaveLength(4);
    expect(compiled.contextGraphMutationGeneration.quads).toHaveLength(3);
    expect(compiled.appliedSet.quads).toHaveLength(7);
    expect(compiled.currentHead.expectedObject).toBe(
      `"${'a'.repeat(64)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`,
    );
    expect(Reflect.ownKeys(compiled).sort()).toEqual([
      'appliedSet',
      'authorSealGraph',
      'authorSealQuads',
      'authorSealSubject',
      'contextGraphMutationGeneration',
      'currentHead',
      'sharedProjectionGraph',
      'sharedProjectionQuads',
      'subgraphMutationGeneration',
    ]);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  it('initializes the first content-bearing semantic commit at version and generation one', () => {
    const first = firstCommitInput();
    expect(() => compileRfc64SemanticAuthorCommitV1(first)).not.toThrow();
    expect(() => compileRfc64SemanticAuthorCommitV1({
      ...first,
      nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
        ...first.nextCurrentHead.value,
        catalogVersion: '0',
      }),
    })).toThrow(/version one/u);
    expect(() => compileRfc64SemanticAuthorCommitV1({
      ...first,
      nextSubgraphMutation: record('SubgraphMutationGuardV1', {
        ...first.nextSubgraphMutation.value,
        generation: '0',
      }),
    })).toThrow(/generation must be one/u);
  });

  it('atomically installs a valid first publication and conflicts on replay', async () => {
    const store = new OxigraphStore();
    try {
      const first = firstCommitInput();
      const compiled = compileRfc64SemanticAuthorCommitV1(first);
      await expect(store.rfc64AuthorCommitCasV1!(compiled)).resolves.toBe('committed');
      const gateway = new SyncSemanticStoreV1(store);
      for (const expected of [
        first.nextCurrentHead,
        first.nextSubgraphMutation,
        first.nextContextGraphMutation,
        first.nextAppliedSet,
      ]) {
        const result = await gateway.read({ coordinate: coordinateOf(expected) }, {
          timeoutMs: 1_000,
        });
        expect(result.kind, expected.recordType).toBe('record');
        if (result.kind === 'record') expect(result.decoded.record).toEqual(expected);
      }
      expect(await store.countQuads(PROJECTION_GRAPH)).toBe(1);
      expect(await store.countQuads(SEAL_GRAPH)).toBe(14);
      await expect(store.rfc64AuthorCommitCasV1!(compiled)).resolves.toBe('conflict');
    } finally {
      await store.close();
    }
  });

  it('atomically installs full typed records and retains now-stale applied seals', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...semanticQuads(EXPECTED_HEAD),
        ...semanticQuads(EXPECTED_SUBGRAPH_MUTATION),
        ...semanticQuads(EXPECTED_CG_MUTATION),
        ...semanticQuads(EXPECTED_APPLIED_SET),
        ...semanticQuads(STALE_SUBGRAPH_SEAL),
        ...semanticQuads(STALE_CG_SEAL),
        quad('urn:test:old', 'urn:test:value', '"old"', PROJECTION_GRAPH),
        quad(SEAL_SUBJECT, 'urn:test:value', '"old-seal"', SEAL_GRAPH),
      ]);
      const compiled = compileRfc64SemanticAuthorCommitV1(commitInput());
      await expect(store.rfc64AuthorCommitCasV1!(compiled)).resolves.toBe('committed');

      const gateway = new SyncSemanticStoreV1(store);
      for (const expected of [
        NEXT_HEAD,
        NEXT_SUBGRAPH_MUTATION,
        NEXT_CG_MUTATION,
        NEXT_APPLIED_SET,
        STALE_SUBGRAPH_SEAL,
        STALE_CG_SEAL,
      ]) {
        const result = await gateway.read({ coordinate: coordinateOf(expected) }, {
          timeoutMs: 1_000,
        });
        expect(result.kind, expected.recordType).toBe('record');
        if (result.kind === 'record') expect(result.decoded.record).toEqual(expected);
      }
      await expect(store.rfc64AuthorCommitCasV1!(compiled)).resolves.toBe('conflict');
    } finally {
      await store.close();
    }
  });

  it('rejects cross-scope, stale-generation, invalid-head, and adorned inputs', () => {
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextSubgraphMutation: record('SubgraphMutationGuardV1', {
        ...NEXT_SUBGRAPH_MUTATION.value,
        subGraphName: 'other' as SubGraphNameV1,
      }),
    }))).toThrow(/author lane differs/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextContextGraphMutation: record('ContextGraphMutationGuardV1', {
        ...NEXT_CG_MUTATION.value,
        generation: '10',
      }),
    }))).toThrow(/advance by exactly one/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextAppliedSet: record('AppliedSubgraphSetRefV1', {
        ...NEXT_APPLIED_SET.value,
        generation: '10',
      }),
    }))).toThrow(/advance by exactly one/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: EXPECTED_HEAD,
    }))).toThrow(/exactly one version/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
        ...NEXT_HEAD.value,
        catalogHeadDigest: EXPECTED_HEAD.value.catalogHeadDigest,
      }),
    }))).toThrow(/exactly one version/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
        ...NEXT_HEAD.value,
        catalogVersion: '6',
      }),
    }))).toThrow(/exactly one version/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
        ...NEXT_HEAD.value,
        catalogEra: '2',
      }),
    }))).toThrow(/authority scope/u);
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      expectedCurrentHead: null,
      nextCurrentHead: NEXT_HEAD,
    }))).toThrow(/version one/u);
    expect(() => compileRfc64SemanticAuthorCommitV1({
      ...commitInput(),
      rawSparql: 'DROP ALL',
    })).toThrow(/invalid field set/u);
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1({
      ...commitInput(),
      rawSparql: 'DROP ALL',
    }), 'rfc64-semantic-author-commit-schema');
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
        ...NEXT_HEAD.value,
        catalogVersion: '6',
      }),
    })), 'rfc64-semantic-author-commit-generation');

    let invoked = false;
    const adorned = { ...commitInput() } as Record<string, unknown>;
    Object.defineProperty(adorned, 'authorSealGraph', {
      enumerable: true,
      get() {
        invoked = true;
        return SEAL_GRAPH;
      },
    });
    expect(() => compileRfc64SemanticAuthorCommitV1(adorned)).toThrow(
      /invalid field set/u,
    );
    expect(invoked).toBe(false);

    let quadInvoked = false;
    const quads = [...commitInput().sharedProjectionQuads];
    Object.defineProperty(quads, '0', {
      enumerable: true,
      get() {
        quadInvoked = true;
        return commitInput().sharedProjectionQuads[0];
      },
    });
    expect(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      sharedProjectionQuads: quads,
    }))).toThrow(/enumerable data properties/u);
    expect(quadInvoked).toBe(false);

    const otherCg = '0x1111111111111111111111111111111111111111/2' as ContextGraphIdV1;
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextAppliedSet: record('AppliedSubgraphSetRefV1', {
        ...NEXT_APPLIED_SET.value,
        contextGraphId: otherCg,
      }),
    })), 'rfc64-semantic-author-commit-scope');
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextAppliedSet: record('AppliedSubgraphSetRefV1', {
        ...NEXT_APPLIED_SET.value,
        networkId: 'otp:99999' as NetworkIdV1,
      }),
    })), 'rfc64-semantic-author-commit-scope');
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      sharedProjectionGraph: `${PROJECTION_GRAPH}-other`,
      sharedProjectionQuads: [quad(
        'urn:test:new',
        'urn:test:value',
        '"new"',
        `${PROJECTION_GRAPH}-other`,
      )],
    })), 'rfc64-semantic-author-commit-scope');
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      expectedAppliedSet: record('AppliedSubgraphSetRefV1', {
        ...EXPECTED_APPLIED_SET.value,
        generation: '9',
      }),
      nextAppliedSet: record('AppliedSubgraphSetRefV1', {
        ...NEXT_APPLIED_SET.value,
        generation: '10',
      }),
    })), 'rfc64-semantic-author-commit-generation');

    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      nextCurrentHead: {
        ...NEXT_HEAD,
        value: {
          ...NEXT_HEAD.value,
          catalogVersion: 5,
        },
      } as unknown as CurrentHeadRecordForTest,
    })), 'rfc64-semantic-author-commit-schema');
  });

  it('rejects a same-digest predecessor whose stored version differs', async () => {
    const store = new OxigraphStore();
    try {
      const unexpectedHead = record('CurrentAuthorCatalogRefV1', {
        ...EXPECTED_HEAD.value,
        catalogVersion: '3',
      });
      await store.insert([
        ...semanticQuads(unexpectedHead),
        ...semanticQuads(EXPECTED_SUBGRAPH_MUTATION),
        ...semanticQuads(EXPECTED_CG_MUTATION),
        ...semanticQuads(EXPECTED_APPLIED_SET),
      ]);
      const compiled = compileRfc64SemanticAuthorCommitV1(commitInput());
      await expect(store.rfc64AuthorCommitCasV1!(compiled)).resolves.toBe('conflict');
      const gateway = new SyncSemanticStoreV1(store);
      const current = await gateway.read({ coordinate: coordinateOf(unexpectedHead) }, {
        timeoutMs: 1_000,
      });
      expect(current.kind).toBe('record');
      if (current.kind === 'record') expect(current.decoded.record).toEqual(unexpectedHead);
      expect(await store.countQuads(PROJECTION_GRAPH)).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('rejects different-author, incomplete, and altered canonical author seals', () => {
    const otherAuthor = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
    const otherCoordinate = Object.freeze({
      ...SEAL_COORDINATE,
      authorAddress: otherAuthor,
    }) as CanonicalGraphScopedAuthorSealCoordinateV1;
    const otherSeal = Object.freeze({
      ...AUTHOR_SEAL,
      authorAddress: otherAuthor,
      kaUal: `did:dkg:${NETWORK}/${otherAuthor}/${KA_NUMBER}`,
      reservedKaId: ((BigInt(otherAuthor) << 96n) | BigInt(KA_NUMBER)).toString(),
    }) as CanonicalGraphScopedAuthorSealV1;
    const otherPlacement = deriveCanonicalGraphScopedAuthorSealPlacementV1(otherCoordinate);
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      authorSealGraph: otherPlacement.metaGraph,
      authorSealSubject: otherPlacement.subject,
      authorSealQuads: projectCanonicalGraphScopedAuthorSealRowsV1(otherSeal, otherCoordinate),
    })), 'rfc64-semantic-author-commit-scope');

    const canonicalRows = [...commitInput().authorSealQuads];
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      authorSealQuads: canonicalRows.slice(1),
    })), 'rfc64-semantic-author-commit-schema');
    expectErrorCode(() => compileRfc64SemanticAuthorCommitV1(commitInput({
      authorSealQuads: canonicalRows.map((row) => row.predicate
        === ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT
        ? { ...row, object: `"${'f'.repeat(64)}"` }
        : row),
    })), 'rfc64-semantic-author-commit-schema');
  });

  it('persists exactly one complete semantic winner across competing worker commits and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc64-semantic-author-worker-'));
    const path = join(dir, 'store.nq');
    const competingHead = record('CurrentAuthorCatalogRefV1', {
      ...NEXT_HEAD.value,
      catalogHeadDigest: DIGEST_C,
    });
    const competingAppliedSet = record('AppliedSubgraphSetRefV1', {
      ...NEXT_APPLIED_SET.value,
      appliedDirectoryRootDigest: DIGEST_A,
    });
    const winnerA = compileRfc64SemanticAuthorCommitV1(commitInput({
      sharedProjectionQuads: [quad('urn:test:winner', 'urn:test:value', '"a"', PROJECTION_GRAPH)],
    }));
    const winnerB = compileRfc64SemanticAuthorCommitV1(commitInput({
      sharedProjectionQuads: [quad('urn:test:winner', 'urn:test:value', '"b"', PROJECTION_GRAPH)],
      nextCurrentHead: competingHead,
      nextAppliedSet: competingAppliedSet,
    }));
    let store: OxigraphWorkerStore | null = new OxigraphWorkerStore(path);
    try {
      await store.insert([
        ...semanticQuads(EXPECTED_HEAD),
        ...semanticQuads(EXPECTED_SUBGRAPH_MUTATION),
        ...semanticQuads(EXPECTED_CG_MUTATION),
        ...semanticQuads(EXPECTED_APPLIED_SET),
      ]);
      const outcomes = await Promise.all([
        store.rfc64AuthorCommitCasV1!(winnerA),
        store.rfc64AuthorCommitCasV1!(winnerB),
      ]);
      expect([...outcomes].sort()).toEqual(['committed', 'conflict']);
      const winnerIndex = outcomes[0] === 'committed' ? 0 : 1;
      const expectedRecords = winnerIndex === 0
        ? [NEXT_HEAD, NEXT_SUBGRAPH_MUTATION, NEXT_CG_MUTATION, NEXT_APPLIED_SET]
        : [competingHead, NEXT_SUBGRAPH_MUTATION, NEXT_CG_MUTATION, competingAppliedSet];
      await store.close();
      store = new OxigraphWorkerStore(path);
      const gateway = new SyncSemanticStoreV1(store);
      for (const expected of expectedRecords) {
        const result = await gateway.read({ coordinate: coordinateOf(expected) }, {
          timeoutMs: 2_000,
        });
        expect(result.kind, expected.recordType).toBe('record');
        if (result.kind === 'record') expect(result.decoded.record).toEqual(expected);
      }
      const projection = await store.query(
        `SELECT ?o WHERE { GRAPH <${PROJECTION_GRAPH}> { <urn:test:winner> <urn:test:value> ?o } }`,
      );
      expect(projection.type).toBe('bindings');
      if (projection.type === 'bindings') {
        expect(projection.bindings).toEqual([{ o: winnerIndex === 0 ? '"a"' : '"b"' }]);
      }
    } finally {
      await store?.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type CurrentHeadRecordForTest = Extract<
  Rfc64SemanticRecordV1,
  { readonly recordType: 'CurrentAuthorCatalogRefV1' }
>;

function commitInput(
  overrides: Partial<Rfc64SemanticAuthorCommitInputV1> = {},
): Rfc64SemanticAuthorCommitInputV1 {
  return {
    sharedProjectionGraph: PROJECTION_GRAPH,
    sharedProjectionQuads: [
      quad('urn:test:new', 'urn:test:value', '"new"', PROJECTION_GRAPH),
    ],
    authorSealGraph: SEAL_GRAPH,
    authorSealSubject: SEAL_SUBJECT,
    authorSealQuads: [...projectCanonicalGraphScopedAuthorSealRowsV1(
      AUTHOR_SEAL,
      SEAL_COORDINATE,
    )],
    expectedCurrentHead: EXPECTED_HEAD,
    nextCurrentHead: NEXT_HEAD,
    expectedSubgraphMutation: EXPECTED_SUBGRAPH_MUTATION,
    nextSubgraphMutation: NEXT_SUBGRAPH_MUTATION,
    expectedContextGraphMutation: EXPECTED_CG_MUTATION,
    nextContextGraphMutation: NEXT_CG_MUTATION,
    expectedAppliedSet: EXPECTED_APPLIED_SET,
    nextAppliedSet: NEXT_APPLIED_SET,
    ...overrides,
  };
}

function firstCommitInput(): Rfc64SemanticAuthorCommitInputV1 {
  return commitInput({
    expectedCurrentHead: null,
    nextCurrentHead: record('CurrentAuthorCatalogRefV1', {
      ...NEXT_HEAD.value,
      catalogVersion: '1',
    }),
    expectedSubgraphMutation: null,
    nextSubgraphMutation: record('SubgraphMutationGuardV1', {
      ...NEXT_SUBGRAPH_MUTATION.value,
      generation: '1',
    }),
    expectedContextGraphMutation: null,
    nextContextGraphMutation: record('ContextGraphMutationGuardV1', {
      ...NEXT_CG_MUTATION.value,
      generation: '1',
    }),
    expectedAppliedSet: null,
    nextAppliedSet: record('AppliedSubgraphSetRefV1', {
      ...NEXT_APPLIED_SET.value,
      generation: '1',
    }),
  });
}

function semanticQuads(recordValue: Rfc64SemanticRecordV1): Quad[] {
  return projectRfc64SemanticRecordStoreRowsV1(recordValue)
    .map(renderRfc64SemanticStoreRowV1);
}

function coordinateOf(recordValue: Rfc64SemanticRecordV1): Rfc64SemanticRecordCoordinateV1 {
  const common = {
    recordType: recordValue.recordType,
    networkId: recordValue.value.networkId,
    contextGraphId: recordValue.value.contextGraphId,
  };
  if (recordValue.recordType === 'CurrentAuthorCatalogRefV1') {
    return {
      ...common,
      recordType: recordValue.recordType,
      subGraphName: recordValue.value.subGraphName,
      authorAddress: recordValue.value.authorAddress,
    };
  }
  if (
    recordValue.recordType === 'AppliedSubgraphSealV1'
    || recordValue.recordType === 'SubgraphMutationGuardV1'
    || recordValue.recordType === 'SubgraphReconcileTargetGuardV1'
  ) {
    return {
      ...common,
      recordType: recordValue.recordType,
      subGraphName: recordValue.value.subGraphName,
    };
  }
  return { ...common, recordType: recordValue.recordType };
}

function record<Type extends Rfc64SemanticRecordV1['recordType']>(
  recordType: Type,
  value: Extract<Rfc64SemanticRecordV1, { recordType: Type }>['value'],
): Extract<Rfc64SemanticRecordV1, { recordType: Type }> {
  return Object.freeze({ recordType, value: Object.freeze(value) }) as Extract<
    Rfc64SemanticRecordV1,
    { recordType: Type }
  >;
}

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return Object.freeze({ subject, predicate, object, graph });
}

function expectErrorCode(
  action: () => unknown,
  code: Rfc64SemanticAuthorCommitErrorV1['code'],
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Rfc64SemanticAuthorCommitErrorV1);
  expect((thrown as Rfc64SemanticAuthorCommitErrorV1).code).toBe(code);
}
