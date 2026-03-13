import { assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import type { TripleStore, Quad } from './triple-store.js';
import type { GraphManager } from './graph-manager.js';

/**
 * Manages private (publisher-only) triples. These live in the same paranet
 * data graph as public triples, but are only stored on the publisher's node.
 * The meta graph records which KAs have private triples (via privateMerkleRoot
 * and privateTripleCount).
 */
export class PrivateContentStore {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  /** Tracks which rootEntities have private triples on this node. */
  private readonly privateEntities = new Map<string, Set<string>>();

  constructor(store: TripleStore, graphManager: GraphManager) {
    this.store = store;
    this.graphManager = graphManager;
  }

  async storePrivateTriples(
    paranetId: string,
    rootEntity: string,
    quads: Quad[],
  ): Promise<void> {
    if (quads.length === 0) return;

    const graphUri = this.graphManager.privateGraphUri(paranetId);
    const normalized = quads.map((q) => ({ ...q, graph: graphUri }));
    await this.store.insert(normalized);

    let entities = this.privateEntities.get(paranetId);
    if (!entities) {
      entities = new Set();
      this.privateEntities.set(paranetId, entities);
    }
    entities.add(rootEntity);
  }

  async getPrivateTriples(
    paranetId: string,
    rootEntity: string,
  ): Promise<Quad[]> {
    const graphUri = this.graphManager.privateGraphUri(paranetId);
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
      object: row['o'],
      graph: graphUri,
    }));
  }

  hasPrivateTriples(paranetId: string, rootEntity: string): boolean {
    const entities = this.privateEntities.get(paranetId);
    return entities?.has(rootEntity) ?? false;
  }

  /**
   * Checks the store directly for whether private triples exist.
   * Useful when the in-memory tracker hasn't been populated (e.g., on a
   * different instance than the one that originally stored the triples).
   */
  async hasPrivateTriplesInStore(
    paranetId: string,
    rootEntity: string,
  ): Promise<boolean> {
    const quads = await this.getPrivateTriples(paranetId, rootEntity);
    return quads.length > 0;
  }

  async deletePrivateTriples(
    paranetId: string,
    rootEntity: string,
  ): Promise<void> {
    const graphUri = this.graphManager.privateGraphUri(paranetId);
    await this.store.deleteBySubjectPrefix(graphUri, rootEntity);
    const entities = this.privateEntities.get(paranetId);
    if (entities) entities.delete(rootEntity);
  }
}
