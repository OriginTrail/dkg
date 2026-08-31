// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  contextGraphWorkspaceGraphUri,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';
import {
  invalidateSwmMaterializationWitness,
  quadsToNQuads,
  readExactGraphPaged,
  readExactGraphPagedWithDiscoveredCount,
  tryReplaceGraphAndSubjectAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

import { unpackKnowledgeAssetId } from '../ka-identity.js';
import { failRfc64PublicCatalogNativeV1 as fail } from
  './public-catalog-native-errors-v1.js';

const MAX_TRANSITION_JOURNAL_ENTRIES_V1 = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;
const MAX_TRANSITION_GRAPH_QUADS_V1 =
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxPublicTriples;
const MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1 = 256 * 1024 * 1024;
const MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1 = 15;

export interface Rfc64CatalogOwnedRowRemovalV1 {
  readonly kaId: KaIdV1;
  readonly swmGraph: string;
  readonly sealMetaGraph: string;
  readonly sealSubject: string;
}

export interface Rfc64SemanticTransitionLocationV1 {
  readonly swmGraph: string;
  readonly sealMetaGraph: string;
  readonly sealSubject: string;
}

interface Rfc64SemanticTransitionPreimageV1
  extends Rfc64SemanticTransitionLocationV1 {
  readonly graphQuads: readonly Readonly<Quad>[];
  readonly sealQuads: readonly Readonly<Quad>[];
}

export function planRfc64CatalogOwnedRowRemovalV1(
  scope: Readonly<AuthorCatalogScopeV1>,
  row: Readonly<AuthorCatalogRowV1>,
): Readonly<Rfc64CatalogOwnedRowRemovalV1> {
  const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1({
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    assertionCoordinate: row.assertionCoordinate,
  });
  return Object.freeze({
    kaId: row.kaId,
    swmGraph: deriveRfc64PublicSwmGraphV1(scope.contextGraphId, row.kaId),
    sealMetaGraph: placement.metaGraph,
    sealSubject: placement.subject,
  });
}

export function transitionLocationFromRfc64RemovalV1(
  removal: Readonly<Rfc64CatalogOwnedRowRemovalV1>,
): Readonly<Rfc64SemanticTransitionLocationV1> {
  return Object.freeze({
    swmGraph: removal.swmGraph,
    sealMetaGraph: removal.sealMetaGraph,
    sealSubject: removal.sealSubject,
  });
}

export async function snapshotRfc64SemanticTransitionV1(
  store: TripleStore,
  locations: readonly Readonly<Rfc64SemanticTransitionLocationV1>[],
): Promise<readonly Readonly<Rfc64SemanticTransitionPreimageV1>[]> {
  if (locations.length > MAX_TRANSITION_JOURNAL_ENTRIES_V1) {
    fail(
      'catalog-native-receiver-activation',
      `semantic transition exceeds ${MAX_TRANSITION_JOURNAL_ENTRIES_V1} exact preimages`,
    );
  }
  const journal: Rfc64SemanticTransitionPreimageV1[] = [];
  try {
    for (const location of locations) {
      const graphQuads = await readExactGraphPagedWithDiscoveredCount(
        store,
        location.swmGraph,
        {
          maxQuadCount: MAX_TRANSITION_GRAPH_QUADS_V1,
          maxNQuadsBytes: MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1,
          outputGraph: location.swmGraph,
          queryOptions: { source: 'rfc64-public-catalog-transition-snapshot' },
        },
      );
      const sealQuads = await readExactSealSubjectRowsV1(
        store,
        location.sealMetaGraph,
        location.sealSubject,
        'rfc64-public-catalog-transition-snapshot',
      );
      journal.push(Object.freeze({
        ...location,
        graphQuads: Object.freeze(graphQuads.map((quad) => Object.freeze({ ...quad }))),
        sealQuads,
      }));
    }
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      'bounded exact semantic transition snapshot failed before mutation',
      cause,
    );
  }
  return Object.freeze(journal);
}

export async function restoreRfc64SemanticTransitionV1(
  store: TripleStore,
  journal: readonly Readonly<Rfc64SemanticTransitionPreimageV1>[],
): Promise<void> {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const preimage = journal[index];
    if (preimage === undefined) continue;
    const restored = await tryReplaceGraphAndSubjectAtomically(
      store,
      preimage.swmGraph,
      preimage.graphQuads.map((quad) => ({ ...quad })),
      preimage.sealMetaGraph,
      preimage.sealSubject,
      preimage.sealQuads.map((quad) => ({ ...quad })),
      { source: 'rfc64-public-catalog-transition-rollback' },
    );
    if (!restored) {
      throw new Error('store lacks atomic graph/subject replacement during semantic rollback');
    }
    await assertExactSemanticTransitionPreimageV1(store, preimage);
  }
}

export async function deactivateRfc64CatalogOwnedProjectionV1(
  store: TripleStore,
  removal: Readonly<Rfc64CatalogOwnedRowRemovalV1>,
): Promise<void> {
  let replaced: boolean;
  try {
    replaced = await tryReplaceGraphAndSubjectAtomically(
      store,
      removal.swmGraph,
      [],
      removal.sealMetaGraph,
      removal.sealSubject,
      [],
      { source: 'rfc64-public-catalog-native-deactivation' },
    );
  } catch (cause) {
    fail(
      'catalog-native-receiver-activation',
      `atomic SWM projection and author-seal removal failed for KA ${removal.kaId}`,
      cause,
    );
  }
  if (!replaced) {
    fail(
      'catalog-native-receiver-activation',
      'store lacks atomic named-graph and author-seal replacement for catalog removal',
    );
  }
  await invalidateSwmMaterializationWitness(store, removal.swmGraph, {
    source: 'rfc64-public-catalog-native-deactivation.witnessInvalidate',
  }).catch(() => {});
  let graphExists: boolean;
  let sealRows;
  try {
    graphExists = await store.hasGraph(removal.swmGraph, {
      source: 'rfc64-public-catalog-native-removal-post-read',
    });
    sealRows = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${removal.sealMetaGraph}> { `
        + `<${removal.sealSubject}> ?p ?o } } LIMIT 1`,
      {
        source: 'rfc64-public-catalog-native-removal-post-read',
        maxResponseBytes: 4 * 1024,
      },
    );
  } catch (cause) {
    fail('catalog-native-receiver-activation', 'removed-row exact post-read failed', cause);
  }
  if (graphExists || sealRows.type !== 'bindings' || sealRows.bindings.length !== 0) {
    fail(
      'catalog-native-receiver-activation',
      `removed KA ${removal.kaId} projection or author seal remains present`,
    );
  }
}

export function deriveRfc64PublicSwmGraphV1(
  contextGraphId: ContextGraphIdV1,
  kaId: KaIdV1,
): string {
  const identity = unpackKnowledgeAssetId(BigInt(kaId));
  return `${contextGraphWorkspaceGraphUri(contextGraphId)}`
    + `/${identity.agentAddress}/${identity.kaNumber.toString()}`;
}

async function assertExactSemanticTransitionPreimageV1(
  store: TripleStore,
  preimage: Readonly<Rfc64SemanticTransitionPreimageV1>,
): Promise<void> {
  const [graphQuads, sealQuads] = await Promise.all([
    readExactGraphPaged(store, preimage.swmGraph, {
      expectedQuadCount: preimage.graphQuads.length,
      maxQuadCount: MAX_TRANSITION_GRAPH_QUADS_V1,
      maxNQuadsBytes: MAX_TRANSITION_GRAPH_NQUADS_BYTES_V1,
      outputGraph: preimage.swmGraph,
      queryOptions: { source: 'rfc64-public-catalog-transition-rollback-post-read' },
    }),
    readExactSealSubjectRowsV1(
      store,
      preimage.sealMetaGraph,
      preimage.sealSubject,
      'rfc64-public-catalog-transition-rollback-post-read',
    ),
  ]);
  if (
    canonicalQuadSetV1(graphQuads) !== canonicalQuadSetV1(preimage.graphQuads)
    || canonicalQuadSetV1(sealQuads) !== canonicalQuadSetV1(preimage.sealQuads)
  ) throw new Error('semantic transition rollback post-read differs from its exact preimage');
}

async function readExactSealSubjectRowsV1(
  store: TripleStore,
  metaGraph: string,
  subject: string,
  source: string,
): Promise<readonly Readonly<Quad>[]> {
  const result = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } } `
      + `ORDER BY ?p ?o LIMIT ${MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1 + 1}`,
    { source, maxResponseBytes: 64 * 1024 },
  );
  if (result.type !== 'bindings' || result.bindings.length > MAX_TRANSITION_SEAL_SUBJECT_ROWS_V1) {
    throw new Error('exact transition seal subject exceeds its bounded row contract');
  }
  return Object.freeze(result.bindings.map((row) => {
    if (typeof row.p !== 'string' || typeof row.o !== 'string') {
      throw new Error('exact transition seal subject row is incomplete');
    }
    return Object.freeze({ subject, predicate: row.p, object: row.o, graph: metaGraph });
  }));
}

function canonicalQuadSetV1(quads: readonly Readonly<Quad>[]): string {
  return quadsToNQuads([...quads].sort(compareQuads));
}

function compareQuads(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return left.subject.localeCompare(right.subject)
    || left.predicate.localeCompare(right.predicate)
    || left.object.localeCompare(right.object)
    || left.graph.localeCompare(right.graph);
}
