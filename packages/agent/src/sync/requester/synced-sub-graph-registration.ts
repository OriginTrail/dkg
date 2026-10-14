// SPDX-License-Identifier: Apache-2.0

/**
 * Registration of a named sub-graph whose shared memory arrived by sync.
 *
 * A share into a named sub-graph registers that sub-graph in its graph's
 * `_meta` when the share arrives live: `workspace-handler.ts` for a direct
 * send, `gossip-publish-handler.ts` for gossip. Shared-memory sync did not. It
 * accepts the sub-graph lanes a responder serves
 * (`discoverSwmRecoverySubGraphNames`), and a responder serves only the
 * sub-graphs it has registered; the registration itself was left to the
 * durable sync of `_meta`. A catalog-authoritative graph has no durable sync,
 * so a node that received a share into a sub-graph only by sync stored it and
 * could not use it: a read over the graph's partitions leaves out a sub-graph
 * that is not registered, a write or publish into it is refused, and the node
 * served it to nobody.
 * Members of a public graph that reach each other only through its owner get
 * each other's sub-graph shares exactly this way: the owner is sent the share,
 * and the other members sync it from the owner.
 *
 * Rows that a sync round stores in a named sub-graph's shared memory now
 * register that sub-graph, with the check and the triples the live paths use.
 */

import { assertSafeIri, contextGraphSubGraphUri } from '@origintrail-official/dkg-core';
import { generateSubGraphRegistration, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { sharedMemoryGraphSubGraphName } from '../shared-memory-graphs.js';

const PUBLISHER_PEER_ID = 'http://dkg.io/ontology/publisherPeerId';
/** A publisher value used for `createdBy`: a peer id or an address, nothing that could break the IRI. */
const PLAIN_IDENTIFIER = /^"([A-Za-z0-9]{1,128})"$/;

/**
 * `createdBy` when the stored rows name no publisher, like `swm-discovery` and
 * `gossip-discovery` on the live paths. The field is informational: nothing
 * reads it for authorization.
 */
export const SYNCED_SUB_GRAPH_CREATED_BY_FALLBACK = 'swm-sync-discovery';

export interface SyncedSubGraphRegistrationPorts {
  readonly store: TripleStore;
  /** The agent's write locks, so that two rounds at once register a sub-graph once. */
  readonly writeLocks: Map<string, Promise<void>>;
  /**
   * Names the node already holds as registered sub-graphs or as child context
   * graphs, as the sync round's admission read them. They are skipped without
   * a store read.
   */
  readonly admittedNames: (contextGraphId: string) => Promise<readonly string[]>;
  /** True when `<graph>/<name>` is a context graph of its own on this node; such a name is never registered. */
  readonly isKnownChildContextGraph: (contextGraphId: string, subGraphName: string) => Promise<boolean>;
}

/** The registrations of one sync session. */
export class SyncedSubGraphRegistration {
  readonly #ports: SyncedSubGraphRegistrationPorts;
  /** `<graph>\0<sub-graph>` pairs settled in this session: registered, found registered, or refused. */
  readonly #settled = new Set<string>();

  constructor(ports: SyncedSubGraphRegistrationPorts) {
    this.#ports = ports;
  }

  /**
   * Register each named sub-graph of `contextGraphId` that `stored` has rows
   * of and that this node has not registered. Returns the names it registered.
   * A failure is thrown and nothing is settled for that name, so the next rows
   * of the sub-graph try again.
   */
  async registerFor(contextGraphId: string, stored: readonly Quad[]): Promise<string[]> {
    const candidates = subGraphsOfStoredRows(contextGraphId, stored);
    if (candidates.size === 0) return [];
    const admitted = new Set(await this.#ports.admittedNames(contextGraphId));
    const registered: string[] = [];
    for (const [subGraphName, publishers] of candidates) {
      const key = `${contextGraphId}\0${subGraphName}`;
      if (this.#settled.has(key)) continue;
      if (!admitted.has(subGraphName)) {
        const createdBy = [...publishers].sort()[0] ?? SYNCED_SUB_GRAPH_CREATED_BY_FALLBACK;
        if (await this.#registerOnce(contextGraphId, subGraphName, createdBy)) registered.push(subGraphName);
      }
      this.#settled.add(key);
    }
    return registered;
  }

  async #registerOnce(contextGraphId: string, subGraphName: string, createdBy: string): Promise<boolean> {
    const { store, writeLocks, isKnownChildContextGraph } = this.#ports;
    return withKeyedLocks(writeLocks, [`${contextGraphId}\0${subGraphName}\0sub-graph-registration`], async () => {
      if (await isSubGraphRegistered(store, contextGraphId, subGraphName)) return false;
      if (await isKnownChildContextGraph(contextGraphId, subGraphName)) return false;
      await new GraphManager(store).ensureSubGraph(contextGraphId, subGraphName);
      await store.insert(generateSubGraphRegistration({
        contextGraphId,
        subGraphName,
        createdBy,
        timestamp: new Date(),
      }));
      return true;
    });
  }
}

/**
 * The named sub-graphs of `contextGraphId` that `rows` belong to, each with
 * the publishers that its operation rows among them name.
 */
export function subGraphsOfStoredRows(
  contextGraphId: string,
  rows: readonly Quad[],
): Map<string, Set<string>> {
  const nameOfGraph = new Map<string, string | undefined>();
  const subGraphs = new Map<string, Set<string>>();
  for (const row of rows) {
    let subGraphName = nameOfGraph.get(row.graph);
    if (!nameOfGraph.has(row.graph)) {
      subGraphName = sharedMemoryGraphSubGraphName(contextGraphId, row.graph);
      nameOfGraph.set(row.graph, subGraphName);
    }
    if (subGraphName === undefined) continue;
    const publishers = subGraphs.get(subGraphName) ?? new Set<string>();
    subGraphs.set(subGraphName, publishers);
    const publisher = row.predicate === PUBLISHER_PEER_ID ? PLAIN_IDENTIFIER.exec(row.object)?.[1] : undefined;
    if (publisher !== undefined) publishers.add(publisher);
  }
  return subGraphs;
}

/** The check the live paths make before they register a sub-graph. */
async function isSubGraphRegistered(
  store: TripleStore,
  contextGraphId: string,
  subGraphName: string,
): Promise<boolean> {
  const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
  const result = await store.query(
    `ASK { GRAPH <${metaGraph}> {
      <${assertSafeIri(contextGraphSubGraphUri(contextGraphId, subGraphName))}> a <http://dkg.io/ontology/SubGraph> ;
        <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
        <http://dkg.io/ontology/createdBy> ?createdBy .
    } }`,
    { source: 'agent.sharedMemorySync.subGraphRegistration' },
  );
  return result.type === 'boolean' && result.value;
}
