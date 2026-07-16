import {
  assertRdfLiteralMutf8Safe,
  assertSafeIri,
  assertSafeRdfTerm,
  canonicalKnowledgeAssetGraphIdentitySuffix,
  escapeSparqlLiteral,
  isSafeIri,
  type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import { tryReplaceGraphAtomically, type TripleStore, type Quad } from './triple-store.js';
import type { ContextGraphManager } from './graph-manager.js';
import {
  readExactGraphPaged,
  readExactGraphPagedWithDiscoveredCount,
  type ReadExactGraphPagedOptions,
} from './bounded-rdf.js';

export interface KnowledgeAssetPrivateReadOptions
  extends Omit<ReadExactGraphPagedOptions, 'expectedQuadCount' | 'outputGraph'> {
  /** Trusted metadata count. When omitted, the store's current count is used. */
  expectedQuadCount?: number;
}

/**
 * GH #1078 — predicate used for the per-(cg,root[,sub]) "current verifiable
 * commitment" marker. Stored on a dedicated `urn:dkg:private-commitment-marker:…`
 * subject inside the private graph so it is (a) never returned by
 * `getPrivateTriples` (which filters on the root subject / its skolem children),
 * (b) never collected by the plaintext dedup scan (different predicate), and
 * (c) dropped together with the private graph on `dropContextGraph`.
 */
const PRIVATE_COMMITMENT_PRED = 'http://dkg.io/ontology/privateCommitment';

/**
 * Manages private triples stored on the local node. Peer-to-peer private
 * payloads are encrypted before they arrive here; after a node decrypts and
 * accepts the payload, RDF terms in the local private graph stay plaintext so
 * normal SPARQL filters and graph reads keep working.
 */
export class PrivateContentStore {
  private readonly store: TripleStore;
  private readonly graphManager: ContextGraphManager;
  /** Tracks which rootEntities have private triples on this node. */
  private readonly privateEntities = new Map<string, Set<string>>();
  /**
   * Serialises the read-existing + insert-missing sequence per private graph.
   * Without this lock, concurrent replays can both observe an empty graph and
   * insert duplicate rows before either insert becomes visible to the other.
   */
  private readonly perGraphWriteLocks = new Map<string, Promise<void>>();

  constructor(store: TripleStore, graphManager: ContextGraphManager) {
    this.store = store;
    this.graphManager = graphManager;
  }

  /**
   * Run `fn` while holding an exclusive lock on `graphUri`. The lock is
   * released when `fn` resolves or rejects; queued waiters then fire in order.
   */
  private async withGraphWriteLock<T>(
    graphUri: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.perGraphWriteLocks.get(graphUri) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const safePrev = prev.catch(() => undefined);
    const chained = safePrev.then(() => next);
    this.perGraphWriteLocks.set(graphUri, chained);
    await safePrev;
    try {
      return await fn();
    } finally {
      release();
      if (this.perGraphWriteLocks.get(graphUri) === chained) {
        this.perGraphWriteLocks.delete(graphUri);
      }
    }
  }

  /**
   * Read the set of already-present `(s, p, object)` triples in `graphUri`
   * whose predicates appear in `incoming`. Scoping the SPARQL read keeps
   * retries bounded without scanning every private quad in the graph.
   */
  private async collectExistingPlaintextKeys(
    graphUri: string,
    incoming: Quad[],
  ): Promise<Set<string>> {
    const subjects = new Set<string>();
    const predicates = new Set<string>();
    for (const q of incoming) {
      subjects.add(q.subject);
      predicates.add(q.predicate);
    }
    if (subjects.size === 0 || predicates.size === 0) return new Set();

    let escapedPredicateVals: string;
    try {
      escapedPredicateVals = [...predicates]
        .map((p) => `<${assertSafeIri(p)}>`)
        .join(' ');
    } catch {
      return new Set();
    }

    let escapedGraph: string;
    try {
      escapedGraph = `<${assertSafeIri(graphUri)}>`;
    } catch {
      return new Set();
    }

    const incomingSubjects = [...subjects];
    const allSubjectsSafe = incomingSubjects.every((s) => isSafeIri(s));

    let sparql: string;
    if (allSubjectsSafe) {
      const subjectVals = incomingSubjects
        .map((s) => `<${assertSafeIri(s)}>`)
        .join(' ');
      sparql = `
        SELECT ?s ?p ?o WHERE {
          GRAPH ${escapedGraph} {
            VALUES ?s { ${subjectVals} }
            VALUES ?p { ${escapedPredicateVals} }
            ?s ?p ?o .
          }
        }
      `;
    } else {
      sparql = `
        SELECT ?s ?p ?o WHERE {
          GRAPH ${escapedGraph} {
            VALUES ?p { ${escapedPredicateVals} }
            ?s ?p ?o .
          }
        }
      `;
    }

    const keys = new Set<string>();
    try {
      const result = await this.store.query(sparql);
      if (result.type !== 'bindings') return keys;
      for (const row of result.bindings) {
        const subjectStr = row['s'];
        const predicateStr = row['p'];
        const objectStr = row['o'];
        if (
          subjectStr === undefined ||
          predicateStr === undefined ||
          objectStr === undefined
        ) {
          continue;
        }
        if (!allSubjectsSafe && !subjects.has(subjectStr)) continue;
        const object = normaliseTermToNTriples(objectStr);
        keys.add(`${subjectStr}\u0001${predicateStr}\u0001${object}`);
      }
    } catch {
      // If the scoped read fails we fall back to no-dedup: worst case is
      // historical duplicate rows, not data loss.
    }
    return keys;
  }

  clearCache(key: string): void {
    this.privateEntities.delete(key);
  }

  private privateGraph(contextGraphId: string, subGraphName?: string): string {
    return subGraphName
      ? this.graphManager.subGraphPrivateUri(contextGraphId, subGraphName)
      : this.graphManager.privateGraphUri(contextGraphId);
  }

  /**
   * Mutable private draft paired with one named WM lifecycle.
   *
   * The final assertion version is not known until finalize, so drafts cannot
   * use the immutable `(UAL, assertionVersion)` graph yet. Keep them in a
   * lifecycle-keyed graph under the private bucket, then atomically materialize
   * the canonical assertion-versioned graph before exposing the seal.
   */
  knowledgeAssetPrivateDraftGraphUri(
    contextGraphId: string,
    agentAddress: string,
    assertionName: string,
    subGraphName?: string,
  ): string {
    const bucket = this.privateGraph(contextGraphId, subGraphName);
    const identity = [agentAddress.toLowerCase(), assertionName]
      .map((part) => encodeURIComponent(part))
      .join(':');
    return assertSafeIri(`${bucket}/_working_memory/${identity}`);
  }

  /** Append private triples to a mutable named-KA draft. */
  async storeKnowledgeAssetPrivateDraftTriples(
    contextGraphId: string,
    agentAddress: string,
    assertionName: string,
    quads: readonly Quad[],
    subGraphName?: string,
  ): Promise<void> {
    if (quads.length === 0) return;
    for (const quad of quads) assertSafePrivateQuad(quad);
    const graphUri = this.knowledgeAssetPrivateDraftGraphUri(
      contextGraphId,
      agentAddress,
      assertionName,
      subGraphName,
    );
    await this.withGraphWriteLock(graphUri, async () => {
      await this.store.insert(quads.map((quad) => ({ ...quad, graph: graphUri })));
    });
  }

  /** Read the complete mutable private draft without exposing its storage graph. */
  async getKnowledgeAssetPrivateDraftTriples(
    contextGraphId: string,
    agentAddress: string,
    assertionName: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    const graphUri = this.knowledgeAssetPrivateDraftGraphUri(
      contextGraphId,
      agentAddress,
      assertionName,
      subGraphName,
    );
    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads') return [];
    return result.quads.map((quad) => ({ ...quad, graph: '' }));
  }

  async deleteKnowledgeAssetPrivateDraft(
    contextGraphId: string,
    agentAddress: string,
    assertionName: string,
    subGraphName?: string,
  ): Promise<void> {
    await this.store.dropGraph(this.knowledgeAssetPrivateDraftGraphUri(
      contextGraphId,
      agentAddress,
      assertionName,
      subGraphName,
    ));
  }

  /**
   * Exact private content graph for one rootless KA assertion.
   *
   * Public VM currently materializes the latest assertion in a stable UAL-derived
   * graph, but private content must remain addressable by the commitment that
   * covered it. Including the assertion version prevents a v2 update from
   * silently overwriting the private payload committed by an earlier version.
   */
  knowledgeAssetPrivateGraphUri(
    contextGraphId: string,
    scope: GraphKnowledgeAssetScope,
    subGraphName?: string,
  ): string {
    const bucket = this.privateGraph(contextGraphId, subGraphName);
    return assertSafeIri(
      `${bucket}/${canonicalKnowledgeAssetGraphIdentitySuffix(scope.agentAddress, BigInt(scope.kaNumber))}`
        + `/assertions/${scope.assertionVersion}`,
    );
  }

  /**
   * Atomically replace the complete private triple set of one graph-scoped KA.
   * No marker triples are mixed into this graph: its contents are exactly the
   * triples covered by the single KA-level private Merkle commitment.
   */
  async replaceKnowledgeAssetPrivateTriples(
    contextGraphId: string,
    scope: GraphKnowledgeAssetScope,
    quads: readonly Quad[],
    subGraphName?: string,
  ): Promise<string> {
    for (const quad of quads) assertSafePrivateQuad(quad);
    const graphUri = this.knowledgeAssetPrivateGraphUri(contextGraphId, scope, subGraphName);
    await this.withGraphWriteLock(graphUri, async () => {
      const replaced = await tryReplaceGraphAtomically(
        this.store,
        graphUri,
        quads.map((quad) => ({ ...quad, graph: graphUri })),
      );
      if (!replaced) {
        throw Object.assign(
          new Error(
            `Triple store cannot atomically replace graph-scoped private content at ${graphUri}`,
          ),
          { code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED' },
        );
      }
    });
    return graphUri;
  }

  /** Read exactly one rootless KA's private triple set. */
  async getKnowledgeAssetPrivateTriples(
    contextGraphId: string,
    scope: GraphKnowledgeAssetScope,
    subGraphName?: string,
    readOptions?: KnowledgeAssetPrivateReadOptions,
  ): Promise<Quad[]> {
    const graphUri = this.knowledgeAssetPrivateGraphUri(contextGraphId, scope, subGraphName);
    if (readOptions?.expectedQuadCount !== undefined) {
      return readExactGraphPaged(this.store, graphUri, {
        ...readOptions,
        expectedQuadCount: readOptions.expectedQuadCount,
        outputGraph: '',
      });
    }
    return readExactGraphPagedWithDiscoveredCount(this.store, graphUri, {
      ...readOptions,
      outputGraph: '',
    });
  }

  async deleteKnowledgeAssetPrivateTriples(
    contextGraphId: string,
    scope: GraphKnowledgeAssetScope,
    subGraphName?: string,
  ): Promise<void> {
    await this.store.dropGraph(
      this.knowledgeAssetPrivateGraphUri(contextGraphId, scope, subGraphName),
    );
  }

  private privateKey(contextGraphId: string, subGraphName?: string): string {
    return subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
  }

  private privateStagingGraph(
    contextGraphId: string,
    shareOperationId: string,
    subGraphName?: string,
  ): string {
    const parts = [contextGraphId, subGraphName ?? '_', shareOperationId]
      .map((part) => encodeURIComponent(part));
    return assertSafeIri(`urn:dkg:private-stage-graph:${parts.join(':')}`);
  }

  async storePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
    commitmentId?: string,
  ): Promise<void> {
    if (quads.length === 0) return;

    assertSafeIri(rootEntity);
    for (const q of quads) {
      assertSafePrivateQuad(q);
    }
    if (commitmentId !== undefined && !/^[A-Za-z0-9_.:-]+$/.test(commitmentId)) {
      throw new Error(`Unsafe private commitmentId: ${commitmentId.slice(0, 80)}`);
    }

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    await this.withGraphWriteLock(graphUri, async () => {
      // GH #1078 — verifiable-commitment scoping. When the caller supplies the
      // commitment this root actually committed (its `privateMerkleRoot`) AND it
      // DIFFERS from the commitment currently recorded for the root, a NEW
      // commitment is superseding a stale one (a re-publish, or a draft slice
      // replaced by the finalized one): drop the root's prior finalized private
      // slice before inserting the new one, so a later hydration / privateData-
      // Anchor never returns a different commitment's triples. With NO
      // commitmentId the behaviour is unchanged (append + dedup), preserving
      // every existing caller and multi-value private predicates.
      if (commitmentId !== undefined) {
        const markerSubject = privateCommitmentMarkerSubject(contextGraphId, rootEntity, subGraphName);
        const current = await this.readPrivateCommitment(graphUri, markerSubject);
        if (current !== commitmentId) {
          // A different (or first) commitment takes over this root: drop the
          // root's prior finalized private slice (a no-op on the very first
          // write) so the new commitment fully replaces it, then stamp the new
          // commitment marker. Repeated stores under the SAME commitment fall
          // through to the append+dedup path below (chunked/retry-safe).
          await this.deleteRootPrivateSlice(graphUri, rootEntity);
          await this.store.deleteByPattern({ graph: graphUri, subject: markerSubject });
          await this.store.insert([{
            subject: markerSubject,
            predicate: PRIVATE_COMMITMENT_PRED,
            object: `"${commitmentId}"`,
            graph: graphUri,
          }]);
        }
      }

      const existingPlainKeys = await this.collectExistingPlaintextKeys(
        graphUri,
        quads,
      );
      const toInsert: Quad[] = [];
      const seenInBatch = new Set<string>();
      for (const q of quads) {
        const key = `${q.subject}\u0001${q.predicate}\u0001${q.object}`;
        if (existingPlainKeys.has(key)) continue;
        if (seenInBatch.has(key)) continue;
        seenInBatch.add(key);
        toInsert.push({
          ...q,
          object: q.object,
          graph: graphUri,
        });
      }
      if (toInsert.length > 0) {
        await this.store.insert(toInsert);
      }
    });

    const key = this.privateKey(contextGraphId, subGraphName);
    let entities = this.privateEntities.get(key);
    if (!entities) {
      entities = new Set();
      this.privateEntities.set(key, entities);
    }
    entities.add(rootEntity);
  }

  async storePrivateTriplesForOperation(
    contextGraphId: string,
    shareOperationId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    assertSafeIri(rootEntity);

    const graphUri = this.privateStagingGraph(contextGraphId, shareOperationId, subGraphName);
    const subject = privateStageSubject(contextGraphId, shareOperationId, rootEntity, subGraphName);
    const predicate = 'http://dkg.io/ontology/privateStagedQuads';
    const stagedPayload = JSON.stringify(JSON.stringify(quads.map((q) => ({ ...q, graph: '' }))));
    assertRdfLiteralMutf8Safe(stagedPayload, {
      label: 'PrivateContentStore.storePrivateTriplesForOperation',
      subject,
      predicate,
      graph: graphUri,
    });
    await this.store.deleteByPattern({ graph: graphUri, subject });
    await this.store.insert([{
      subject,
      predicate,
      object: stagedPayload,
      graph: graphUri,
    }]);
  }

  async getPrivateTriplesForOperation(
    contextGraphId: string,
    shareOperationId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    assertSafeIri(rootEntity);

    const graphUri = this.privateStagingGraph(contextGraphId, shareOperationId, subGraphName);
    const subject = privateStageSubject(contextGraphId, shareOperationId, rootEntity, subGraphName);
    const result = await this.store.query(
      `SELECT ?payload WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          <${assertSafeIri(subject)}> <http://dkg.io/ontology/privateStagedQuads> ?payload .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];
    const payload = parseLiteral(result.bindings[0]?.['payload']);
    if (typeof payload !== 'string') return [];
    const parsed = JSON.parse(payload) as Quad[];
    return parsed.map((q) => ({ ...q, graph: '' }));
  }

  async deletePrivateTriplesForOperation(
    contextGraphId: string,
    shareOperationId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<void> {
    assertSafeIri(rootEntity);

    const graphUri = this.privateStagingGraph(contextGraphId, shareOperationId, subGraphName);
    const subject = privateStageSubject(contextGraphId, shareOperationId, rootEntity, subGraphName);
    await this.store.deleteByPattern({ graph: graphUri, subject });
  }

  async getPrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const sparql = `
      SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${assertSafeIri(rootEntity)}>
            || STRSTARTS(STR(?s), "${escapeSparqlLiteral(rootEntity)}/.well-known/genid/")
          )
        }
      }
    `;
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];

    return result.bindings.map((row) => ({
      subject: row['s'],
      predicate: row['p'],
      object: normaliseTermToNTriples(row['o']),
      graph: graphUri,
    }));
  }

  hasPrivateTriples(contextGraphId: string, rootEntity: string, subGraphName?: string): boolean {
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    return entities?.has(rootEntity) ?? false;
  }

  /**
   * Checks the store directly for whether private triples exist. Useful when
   * the in-memory tracker has not been populated.
   */
  async hasPrivateTriplesInStore(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<boolean> {
    const quads = await this.getPrivateTriples(contextGraphId, rootEntity, subGraphName);
    return quads.length > 0;
  }

  async deletePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<void> {
    assertSafeIri(rootEntity);
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    await this.deleteRootPrivateSlice(graphUri, rootEntity);
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    if (entities) entities.delete(rootEntity);
  }

  /**
   * Delete exactly ONE root's private slice from `graphUri`: the exact root
   * subject plus its skolem children (`<root>/.well-known/genid/…`), the SAME
   * shape `getPrivateTriples` reads. We deliberately do NOT use a bare
   * `deleteBySubjectPrefix(root)` — RDF root IRIs are not prefix-delimited, so a
   * raw prefix would also delete sibling roots that share it (e.g. superseding
   * `urn:device:1` would nuke `urn:device:10`'s private triples). The skolem
   * prefix IS delimited (`…/.well-known/genid/`), so it is collision-safe.
   */
  private async deleteRootPrivateSlice(graphUri: string, rootEntity: string): Promise<void> {
    assertSafeIri(rootEntity);
    await this.store.deleteByPattern({ graph: graphUri, subject: rootEntity });
    await this.store.deleteBySubjectPrefix(graphUri, `${rootEntity}/.well-known/genid/`);
  }

  /**
   * GH #1078 — read the commitment id currently recorded for a root's private
   * slice (undefined when none has been recorded, i.e. legacy/append-only
   * writers). Used to decide whether an incoming commitment supersedes the
   * stored slice.
   */
  private async readPrivateCommitment(
    graphUri: string,
    markerSubject: string,
  ): Promise<string | undefined> {
    const result = await this.store.query(
      `SELECT ?c WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          <${assertSafeIri(markerSubject)}> <${PRIVATE_COMMITMENT_PRED}> ?c .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    const raw = result.bindings[0]?.['c'];
    if (typeof raw !== 'string') return undefined;
    const m = raw.match(/^"([\s\S]*)"(\^\^.*)?$/);
    return m ? m[1] : raw;
  }
}

function privateStageSubject(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity]
    .map((part) => encodeURIComponent(part));
  const subject = `urn:dkg:private-stage:${parts.join(':')}`;
  assertSafeIri(subject);
  return subject;
}

/**
 * GH #1078 — subject for the per-(cg,root[,sub]) commitment marker. Deliberately
 * NOT prefixed by the root IRI so `getPrivateTriples`' root-subject filter and
 * the `deleteBySubjectPrefix(root)` supersede sweep never touch it.
 */
function privateCommitmentMarkerSubject(
  contextGraphId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', rootEntity]
    .map((part) => encodeURIComponent(part));
  const subject = `urn:dkg:private-commitment-marker:${parts.join(':')}`;
  assertSafeIri(subject);
  return subject;
}

function parseLiteral(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function assertSafePrivateQuad(q: Quad): void {
  assertSafeSubjectOrObject(q.subject);
  assertSafeIri(q.predicate);
  assertSafeSubjectOrObject(q.object);
}

function assertSafeSubjectOrObject(term: string): void {
  if (term.startsWith('_:')) {
    assertSafeBlankNode(term);
    return;
  }
  if (term.startsWith('"') || term.startsWith('<')) {
    assertSafeRdfTerm(term);
    return;
  }
  assertSafeIri(term);
}

function assertSafeBlankNode(term: string): void {
  if (!/^_:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(term)) {
    throw new Error(`Unsafe blank node label: ${term.slice(0, 80)}`);
  }
}

/**
 * Normalise an RDF term to the N-Triples lexical form the rest of the codebase
 * passes around (`<iri>`, `"literal"`, `_:bnode`). The triple store adapters
 * emit IRI bindings as bare strings, while literal and blank-node bindings
 * already come back in their expected lexical forms.
 */
function normaliseTermToNTriples(term: string): string {
  if (!term) return term;
  if (term.startsWith('<') || term.startsWith('"') || term.startsWith('_:')) {
    return term;
  }
  return `<${term}>`;
}
