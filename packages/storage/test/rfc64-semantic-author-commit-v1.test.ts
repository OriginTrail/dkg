import { describe, expect, it } from 'vitest';

import {
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
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
const PROJECTION_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory/1`;
const SEAL_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const SEAL_SUBJECT = 'urn:test:rfc64:seal';

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
    const first = commitInput({
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
      /enumerable data properties/u,
    );
    expect(invoked).toBe(false);
  });
});

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
    authorSealQuads: [
      quad(SEAL_SUBJECT, 'urn:test:value', '"new-seal"', SEAL_GRAPH),
    ],
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
