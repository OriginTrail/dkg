// SPDX-License-Identifier: Apache-2.0

import { AGENT_DID_PREFIX, isSafeIri, unwrapIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES } from '@origintrail-official/dkg-publisher';
import type { StoreMutation, StoreMutationOutcome, StoreRemoval } from './store-mutation.js';

/** The predicates a recipient key lookup reads. Each is read only on an agent DID or key IRI subject. */
export const RECIPIENT_KEY_ROUTE_PREDICATES: ReadonlySet<string> = new Set(
  WORKSPACE_RECIPIENT_KEY_ROUTE_PREDICATES,
);

// One branch per predicate, so every pattern is bound by its predicate and the scan
// reads only the key and route facts, never every triple of every graph.
const KEY_GRAPH_SCAN = `SELECT DISTINCT ?g WHERE {
  ${[...RECIPIENT_KEY_ROUTE_PREDICATES].map((predicate) => `{ GRAPH ?g { ?s <${predicate}> ?o } }`).join('\n  UNION\n  ')}
  FILTER(STRSTARTS(STR(?s), "${AGENT_DID_PREFIX}"))
}`;

// Harmlessness is proven only by a bare IRI that is not an agent DID. Some adapters
// read an empty term as a wildcard, rewrite unsafe characters, and turn a blank node
// in a delete into a variable that can match any subject; none of those prove
// anything, and `isSafeIri` refuses all of them (and brackets, and a name without
// a scheme).
const isNonAgentIri = (term: string | undefined): boolean => (
  term !== undefined && isSafeIri(term) && !term.startsWith(AGENT_DID_PREFIX)
);
const isBareIri = (term: string | undefined): term is string => term !== undefined && isSafeIri(term);

// A predicate that is not a bare IRI may be stored under another name (an adapter cleans unsafe
// characters), so it cannot be shown to be something other than a key or route predicate.
const isKeyRouteFact = (quad: Quad): boolean => (
  (RECIPIENT_KEY_ROUTE_PREDICATES.has(unwrapIri(quad.predicate)) || !isBareIri(quad.predicate))
  && !isNonAgentIri(quad.subject)
);

// Proven by the subject or the predicate alone, so it holds in every graph.
const cannotRemoveKeyRouteFact = ({ subject, predicate }: StoreRemoval): boolean => (
  isNonAgentIri(subject) || (isBareIri(predicate) && !RECIPIENT_KEY_ROUTE_PREDICATES.has(predicate))
);

/** Removals of one write that only the emptiness of their graphs proves harmless, while the write is in flight. */
interface GraphBoundRemoval {
  readonly graphs: readonly string[];
  /** Set once one of the graphs gains a key or route fact: the write then counts as a pending key write. */
  counted: boolean;
}

// How many graphs with a removal of unknown outcome are remembered before memoizing is given up.
const UNSETTLED_REMOVAL_GRAPHS_MAX = 256;

/**
 * A revision that moves only when a write can change which recipient keys or
 * routes a private-roster resolution finds. It ignores the job, share, metadata
 * and content writes that move the node-wide authority revision on a busy node.
 *
 * Fail closed: anything this class cannot prove harmless moves the revision.
 * A removal is harmless when its subject is not an agent DID, its predicate is
 * not a key or route predicate, or its graph has never held such a fact. The
 * lookup reads every named graph, so the graphs that hold key facts are found
 * by one scan and kept current from every write that names its quads. A write
 * is opaque when it may change anything, or stores a key fact under a graph
 * name that is not a bare IRI (an adapter may store it under another name): the
 * list is not trusted while it is in flight, nor after it has changed something,
 * until a scan has run again. An opaque write whose outcome is unknown may still
 * commit later, into a graph no scan has seen, so after one the list is never
 * trusted again and a removal moves the revision unless its subject or predicate
 * proves it harmless.
 *
 * A removal that only the emptiness of its graph proves harmless stops being
 * harmless when that graph gains a key fact. While such a removal is in flight
 * it then counts as a pending key write; and after one whose outcome is unknown,
 * a key fact that lands in its graph can vanish unannounced, so nothing is
 * memoized from then on.
 */
export class RecipientKeyRouteFence {
  private value = 0;
  private readonly keyGraphs = new Set<string>();
  private staleGeneration = 0;
  private scannedGeneration = -1;
  private pendingEverything = 0;
  private pendingRecipientWrites = 0;
  private recipientWritesUnknown = false;
  private graphsUnknown = false;
  private readonly graphBoundRemovals = new Set<GraphBoundRemoval>();
  /** Graphs that a removal of unknown outcome may still empty. */
  private readonly graphsWithUnsettledRemoval = new Set<string>();
  private scan: Promise<void> | null = null;

  constructor(private readonly store: TripleStore) {}

  get revision(): number {
    return this.value;
  }

  /** Memoized collects are usable only with settled, trustworthy dependencies. */
  get cacheable(): boolean {
    return this.trusted && !this.recipientWritesUnknown && !this.hasPendingWrites;
  }

  get hasPendingWrites(): boolean { return this.pendingRecipientWrites > 0; }

  private get trusted(): boolean {
    return !this.graphsUnknown && this.scannedGeneration === this.staleGeneration;
  }

  /**
   * A write is about to be dispatched. The graphs of its quads are learned before
   * it can commit, so no removal of one of them completes while it is unknown. An
   * opaque write makes the list untrusted until it has settled and the graphs have
   * been scanned again. Returns what to call when it settles.
   */
  begin(mutation: StoreMutation): (outcome?: StoreMutationOutcome) => void {
    const unscoped = mutation.everything === true
      || mutation.quads?.some((quad) => !isBareIri(quad.predicate)) === true
      || mutation.removals?.some(({ graph }) => !isBareIri(graph)) === true;
    let opaque = unscoped;
    const relevant = unscoped
      || mutation.quads?.some(isKeyRouteFact) === true
      || mutation.removals?.some((removal) => this.removalMayChange(removal)) === true;
    if (relevant) this.pendingRecipientWrites += 1;
    const graphBound = relevant ? undefined : this.watchGraphBoundRemovals(mutation.removals);
    for (const quad of mutation.quads ?? []) {
      if (!isKeyRouteFact(quad)) continue;
      if (isBareIri(quad.graph)) this.learnKeyGraph(quad.graph);
      else opaque = true;
    }
    if (opaque) {
      this.staleGeneration += 1;
      this.pendingEverything += 1;
    }
    let settled = false;
    return (outcome = 'changed') => {
      if (settled) return;
      settled = true;
      try {
        if (outcome !== 'unchanged') {
          if (unscoped) this.noteUnscopedWrite();
          else {
            for (const removal of mutation.removals ?? []) this.noteRemoval(removal);
            if (mutation.quads) this.noteQuads(mutation.quads);
          }
        }
      } finally {
        if (graphBound) this.graphBoundRemovals.delete(graphBound);
        if (relevant || graphBound?.counted) {
          this.pendingRecipientWrites -= 1;
          if (outcome === 'indeterminate') this.recipientWritesUnknown = true;
        } else if (graphBound && outcome === 'indeterminate') {
          this.rememberUnsettledRemoval(graphBound.graphs);
        }
        if (opaque) {
          this.pendingEverything -= 1;
          if (outcome === 'indeterminate') this.graphsUnknown = true;
        }
      }
    };
  }

  /** Quads that were inserted, removed or replaced into a graph. */
  noteQuads(quads: readonly Quad[]): void {
    let changed = false;
    for (const quad of quads) {
      if (!isKeyRouteFact(quad)) continue;
      // A name that is not a bare IRI may be stored under another one: the next scan learns it.
      if (isBareIri(quad.graph)) this.learnKeyGraph(quad.graph);
      else this.staleGeneration += 1;
      changed = true;
    }
    if (changed) this.value += 1;
  }

  /** A removal whose scope is known, in whole or in part. */
  private removalMayChange(removal: StoreRemoval): boolean {
    if (cannotRemoveKeyRouteFact(removal)) return false;
    const { graph } = removal;
    if (isBareIri(graph) && this.trusted && !this.keyGraphs.has(graph)) return false;
    return true;
  }

  /** The graph holds, or is about to hold, a key or route fact. */
  private learnKeyGraph(graph: string): void {
    if (this.keyGraphs.has(graph)) return;
    this.keyGraphs.add(graph);
    // A removal of unknown outcome may still empty this graph, and nothing will say when.
    if (this.graphsWithUnsettledRemoval.has(graph)) this.recipientWritesUnknown = true;
    // A removal in flight that only this graph's emptiness proved harmless is a key write from now on.
    for (const removal of this.graphBoundRemovals) {
      if (removal.counted || !removal.graphs.includes(graph)) continue;
      removal.counted = true;
      this.pendingRecipientWrites += 1;
    }
  }

  /**
   * Called for a write that no rule has made a pending key write. Its removals that
   * neither subject nor predicate proves harmless are harmless only while their graphs
   * hold no key fact, so they are watched until the write settles.
   */
  private watchGraphBoundRemovals(removals: readonly StoreRemoval[] | undefined): GraphBoundRemoval | undefined {
    const graphs = (removals ?? [])
      .filter((removal) => !cannotRemoveKeyRouteFact(removal))
      .map(({ graph }) => graph)
      .filter(isBareIri);
    if (graphs.length === 0) return undefined;
    const watched: GraphBoundRemoval = { graphs, counted: false };
    this.graphBoundRemovals.add(watched);
    return watched;
  }

  /** The removal may still run later; past the bound, memoizing is given up instead of the list growing. */
  private rememberUnsettledRemoval(graphs: readonly string[]): void {
    for (const graph of graphs) this.graphsWithUnsettledRemoval.add(graph);
    if (this.graphsWithUnsettledRemoval.size > UNSETTLED_REMOVAL_GRAPHS_MAX) {
      this.graphsWithUnsettledRemoval.clear();
      this.recipientWritesUnknown = true;
    }
  }

  noteRemoval(removal: StoreRemoval): void {
    if (this.removalMayChange(removal)) this.value += 1;
  }

  /** A write that may have changed anything has changed something (an UPDATE, a prefix delete). */
  noteUnscopedWrite(): void {
    this.value += 1;
    this.staleGeneration += 1;
  }

  /**
   * Make the set of key-holding graphs trustworthy before a resolution reads the
   * revision. A failed scan, or one that overlapped a write that may change
   * anything, leaves it untrusted, so removals keep moving the revision until a
   * later scan.
   */
  async ensureReady(): Promise<void> {
    if (this.trusted || this.graphsUnknown) return;
    this.scan ??= this.scanKeyGraphs().finally(() => { this.scan = null; });
    await this.scan;
  }

  private async scanKeyGraphs(): Promise<void> {
    const generation = this.staleGeneration;
    try {
      const result = await this.store.query(KEY_GRAPH_SCAN, { source: 'agent.recipientKeyRouteFence.scan' });
      if (result.type !== 'bindings') return;
      for (const row of result.bindings) {
        if (typeof row['g'] === 'string') this.learnKeyGraph(unwrapIri(row['g']));
      }
      if (generation === this.staleGeneration && this.pendingEverything === 0) this.scannedGeneration = generation;
    } catch {
      // Not ready: every removal that cannot be proven harmless by subject or predicate still moves the revision.
    }
  }
}
