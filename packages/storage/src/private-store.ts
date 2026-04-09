import { assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import type { TripleStore, Quad } from './triple-store.js';
import type { ContextGraphManager } from './graph-manager.js';

/**
 * Manages private (publisher-only) triples. These live in the same context
 * graph data graph as public triples, but are only stored on the publisher's
 * node. The meta graph records which KAs have private triples (via
 * privateMerkleRoot and privateTripleCount).
 */
export class PrivateContentStore {
  private readonly store: TripleStore;
  private readonly graphManager: ContextGraphManager;
  /** Tracks which rootEntities have private triples on this node. */
  private readonly privateEntities = new Map<string, Set<string>>();

  constructor(store: TripleStore, graphManager: ContextGraphManager) {
    this.store = store;
    this.graphManager = graphManager;
  }

  private privateGraph(contextGraphId: string, subGraphName?: string): string {
    return subGraphName
      ? this.graphManager.subGraphPrivateUri(contextGraphId, subGraphName)
      : this.graphManager.privateGraphUri(contextGraphId);
  }

  private privateKey(contextGraphId: string, subGraphName?: string): string {
    return subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
  }

  async storePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    if (quads.length === 0) return;

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const normalized = quads.map((q) => ({ ...q, graph: graphUri }));
    await this.store.insert(normalized);

    const key = this.privateKey(contextGraphId, subGraphName);
    let entities = this.privateEntities.get(key);
    if (!entities) {
      entities = new Set();
      this.privateEntities.set(key, entities);
    }
    entities.add(rootEntity);
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
      object: row['o'],
      graph: graphUri,
    }));
  }

  hasPrivateTriples(contextGraphId: string, rootEntity: string, subGraphName?: string): boolean {
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    return entities?.has(rootEntity) ?? false;
  }

  /**
   * Checks the store directly for whether private triples exist.
   * Useful when the in-memory tracker hasn't been populated (e.g., on a
   * different instance than the one that originally stored the triples).
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
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    await this.store.deleteBySubjectPrefix(graphUri, rootEntity);
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    if (entities) entities.delete(rootEntity);
  }
}
