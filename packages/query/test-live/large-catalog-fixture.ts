// A store shaped like a large node: about 100,000 named graphs across four
// context graphs, each graph one asset of a few triples. Three context graphs
// only make the catalog large; the tests query the small one and nothing else.
import { createHash } from 'node:crypto';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const NAME = 'http://schema.org/name';
const PRODUCT = 'http://schema.org/Product';
const TRUST_LEVEL = 'http://dkg.io/ontology/trustLevel';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const LAYER_SEGMENT = { working: '_working_memory', shared: '_shared_memory', verifiable: '_verifiable_memory' } as const;

/** Context graph ids of realistic length: the graph names average about 115 characters. */
export const SMALL_CONTEXT_GRAPH = 'catalog-fixture-small-graph';
const SUB_GRAPH = 'orders';
const UNRELATED = [
  { id: 'catalog-fixture-large-graph', verifiable: 38_000, shared: 10_000, working: 2_000 },
  { id: 'catalog-fixture-medium-one', verifiable: 20_000, shared: 5_000, working: 0 },
  { id: 'catalog-fixture-medium-two', verifiable: 19_000, shared: 5_000, working: 1_000 },
] as const;
const AUTHORS_PER_CONTEXT_GRAPH = 50;
const GRAPHS_PER_INSERT = 5_000;

const address = (seed: string) => `0x${createHash('sha1').update(seed).digest('hex')}`;
/** The caller's working-memory namespace; another agent's drafts sit beside it. */
export const AGENT = address('fixture-agent');
const OTHER_AGENT = address('fixture-other-agent');
const contextGraphRoot = (id: string) => `did:dkg:context-graph:${id}`;

/**
 * Where an asset of the small context graph lives: the content graph, a
 * per-asset graph of one memory layer, the shared-memory bucket, the
 * per-chain-id data graph, or a draft keyed by its name.
 */
type Partition = 'content' | 'verifiable' | 'chain' | 'bucket' | 'shared' | 'working' | 'named';

/** One asset of the small context graph, with what decides which reads show it. */
export interface FixtureAsset {
  readonly graph: string;
  readonly subject: string;
  readonly partition: Partition;
  readonly subGraph?: string;
  readonly agent?: string;
  readonly trust?: number;
}

/** The small context graph's assets, the same on every call. */
export function fixtureAssets(): FixtureAsset[] {
  const root = contextGraphRoot(SMALL_CONTEXT_GRAPH);
  const author = (n: number) => address(`${SMALL_CONTEXT_GRAPH}/${n % 7}`);
  const assets: FixtureAsset[] = [];
  const add = (graph: string, partition: Partition, extra: Partial<FixtureAsset> = {}) =>
    assets.push({ graph, subject: `urn:fixture:${SMALL_CONTEXT_GRAPH}:asset:${assets.length}`, partition, ...extra });
  for (const subGraph of [undefined, SUB_GRAPH]) {
    const base = subGraph ? `${root}/${subGraph}` : root;
    const count = subGraph
      ? { content: 2, verifiable: 20, bucket: 1, shared: 8, working: 6, named: 1, otherAgent: 2 }
      : { content: 4, verifiable: 200, bucket: 2, shared: 30, working: 20, named: 3, otherAgent: 10 };
    for (let n = 0; n < count.content; n++) add(base, 'content', { subGraph });
    // Trust levels 0 to 3 in turn: a minTrust read keeps three assets in four.
    for (let n = 0; n < count.verifiable; n++) {
      add(`${base}/${LAYER_SEGMENT.verifiable}/${author(n)}/${n}`, 'verifiable', { subGraph, trust: n % 4 });
    }
    for (let n = 0; n < count.bucket; n++) add(`${base}/${LAYER_SEGMENT.shared}`, 'bucket', { subGraph });
    for (let n = 0; n < count.shared; n++) add(`${base}/${LAYER_SEGMENT.shared}/${author(n)}/${n}`, 'shared', { subGraph });
    for (let n = 0; n < count.working; n++) {
      add(`${base}/${LAYER_SEGMENT.working}/${AGENT}/${n}`, 'working', { subGraph, agent: AGENT });
    }
    for (let n = 0; n < count.named; n++) add(`${base}/assertion/${AGENT}/draft-${n}`, 'named', { subGraph, agent: AGENT });
    for (let n = 0; n < count.otherAgent; n++) {
      add(`${base}/${LAYER_SEGMENT.working}/${OTHER_AGENT}/${n}`, 'working', { subGraph, agent: OTHER_AGENT });
    }
  }
  // Confirmed data that reached only the per-chain-id graph.
  for (let n = 0; n < 3; n++) add(`${root}/context/7`, 'chain');
  return assets;
}

function assetQuads({ graph, subject, trust }: Pick<FixtureAsset, 'graph' | 'subject' | 'trust'>): Quad[] {
  const quads: Quad[] = [
    { graph, subject, predicate: RDF_TYPE, object: PRODUCT },
    { graph, subject, predicate: NAME, object: `"${subject.slice(subject.lastIndexOf(':') + 1)}"` },
  ];
  if (trust !== undefined) quads.push({ graph, subject, predicate: TRUST_LEVEL, object: `"${trust}"^^<${XSD_INTEGER}>` });
  return quads;
}

function* unrelatedAssets(): Generator<Pick<FixtureAsset, 'graph' | 'subject'>> {
  for (const contextGraph of UNRELATED) {
    const root = contextGraphRoot(contextGraph.id);
    const authors = Array.from({ length: AUTHORS_PER_CONTEXT_GRAPH }, (_, n) => address(`${contextGraph.id}/${n}`));
    for (const layer of ['verifiable', 'shared', 'working'] as const) {
      for (let n = 0; n < contextGraph[layer]; n++) {
        yield { graph: `${root}/${LAYER_SEGMENT[layer]}/${authors[n % authors.length]}/${n}`,
          subject: `urn:fixture:${contextGraph.id}:${layer}:${n}` };
      }
    }
  }
}

export interface LargeCatalogFixture {
  /** The small context graph's assets: each read's expected answer is derived from them. */
  readonly assets: readonly FixtureAsset[];
  /** Every graph of the small context graph, its `_meta` graph included. */
  readonly smallGraphs: readonly string[];
  readonly graphCount: number;
  /** The catalog measured as the store measures it: one JSON array of graph names. */
  readonly catalogBytes: number;
  readonly loadMs: number;
}

/**
 * Load the fixture through the store's own insert, a few thousand graphs per
 * request. With `unrelatedGraphs`, only that many of the graphs that make the
 * catalog large are loaded; `loadUnrelatedGraphs` loads the rest later.
 */
export async function loadLargeCatalog(
  store: TripleStore,
  { unrelatedGraphs }: { unrelatedGraphs?: number } = {},
): Promise<LargeCatalogFixture> {
  const started = performance.now();
  const assets = fixtureAssets();
  const root = contextGraphRoot(SMALL_CONTEXT_GRAPH);
  const meta = `${root}/_meta`;
  // The registration that a read naming no sub-graph fans out over.
  await store.insert([
    { graph: meta, subject: `${root}/${SUB_GRAPH}`, predicate: RDF_TYPE, object: 'http://dkg.io/ontology/SubGraph' },
    { graph: meta, subject: `${root}/${SUB_GRAPH}`, predicate: NAME, object: `"${SUB_GRAPH}"` },
    ...assets.flatMap(assetQuads),
  ]);
  const graphs = new Set([meta, ...assets.map(asset => asset.graph)]);
  const smallGraphs = [...graphs];
  for (const graph of await loadUnrelatedGraphs(store, { to: unrelatedGraphs })) graphs.add(graph);
  return { assets, smallGraphs, graphCount: graphs.size, catalogBytes: jsonBytes([...graphs]),
    loadMs: performance.now() - started };
}

/** Load the graphs that make the catalog large, from `from` up to `to` in load order, and return their names. */
export async function loadUnrelatedGraphs(
  store: TripleStore,
  { from = 0, to = Number.POSITIVE_INFINITY }: { from?: number; to?: number } = {},
): Promise<string[]> {
  const loaded: string[] = [];
  let batch: Quad[] = [];
  let position = 0;
  for (const asset of unrelatedAssets()) {
    if (position >= to) break;
    if (position++ < from) continue;
    loaded.push(asset.graph);
    batch.push(...assetQuads(asset));
    if (loaded.length % GRAPHS_PER_INSERT === 0) {
      await store.insert(batch);
      batch = [];
    }
  }
  if (batch.length) await store.insert(batch);
  return loaded;
}

export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Graph-name prefixes of the context graphs that only make the catalog large. */
export const UNRELATED_GRAPH_PREFIXES = UNRELATED.map(({ id }) => `${contextGraphRoot(id)}/`);

/** The names of the graphs that only make the catalog large, in load order. */
export function* unrelatedGraphNames(): Generator<string> {
  for (const asset of unrelatedAssets()) yield asset.graph;
}

export type View = 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
/** One read of the small context graph: a view, or the legacy route of a context graph id alone. */
export interface FixtureRead {
  readonly view?: View;
  readonly subGraphName?: string;
  /** A trust level, 0 to 3; only the verifiable-memory view applies it. */
  readonly minTrust?: number;
}

const PARTITIONS: Record<View | 'legacy', readonly Partition[]> = {
  'working-memory': ['working', 'named'],
  'shared-working-memory': ['bucket', 'shared'],
  'verifiable-memory': ['content', 'verifiable', 'chain'],
  // The content graph and its verifiable-memory graphs; the legacy route does not fan out to sub-graphs.
  legacy: ['content', 'verifiable'],
};

/** The subjects a read must answer with, sorted. */
export function expectedSubjects(assets: readonly FixtureAsset[], { view, subGraphName, minTrust }: FixtureRead): string[] {
  const partitions = PARTITIONS[view ?? 'legacy'];
  return assets.filter(asset => partitions.includes(asset.partition)
    && (view === undefined ? asset.subGraph === subGraphName : !subGraphName || asset.subGraph === subGraphName)
    && (view !== 'working-memory' || asset.agent === AGENT)
    && (view !== 'verifiable-memory' || !minTrust || (asset.trust ?? -1) >= minTrust))
    .map(asset => asset.subject).sort();
}

/** Each view with and without a sub-graph and a trust floor, and the legacy route with and without a sub-graph. */
export const FIXTURE_READS: readonly FixtureRead[] = [
  ...(['working-memory', 'shared-working-memory', 'verifiable-memory'] as const).flatMap(view =>
    [undefined, SUB_GRAPH].flatMap(subGraphName => [undefined, 1].map(minTrust => ({ view, subGraphName, minTrust })))),
  ...[undefined, SUB_GRAPH].map(subGraphName => ({ subGraphName })),
];

const PATTERN = `?s a <${PRODUCT}> ; <${NAME}> ?name`;
/** The three query forms, each over the same pattern. */
export const FIXTURE_QUERIES = {
  SELECT: `SELECT ?s ?name WHERE { ${PATTERN} }`,
  ASK: `ASK WHERE { ${PATTERN} }`,
  CONSTRUCT: `CONSTRUCT { ?s <${NAME}> ?name } WHERE { ${PATTERN} }`,
} as const;
