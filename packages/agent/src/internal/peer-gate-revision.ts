// SPDX-License-Identifier: Apache-2.0

import { isSafeIri } from '@origintrail-official/dkg-core';
import type { StoreRemoval } from './store-mutation.js';

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const DELEGATION_PREFIX = 'did:dkg:agent-delegation:';

/**
 * A revision per context graph that moves only when a write can change the
 * metadata facts its peer allowlist and its agent roster are built from. The
 * graph's own cache is invalidated by every write to its meta graph, among them
 * the knowledge-asset metadata that every publish writes, so that revision says
 * nothing about either; this one lets a resolution check, synchronously and
 * right after its last asynchronous read, that what it collected still holds.
 */
export class PeerGateRevision {
  private everything = 0;
  private readonly graphs = new Map<string, number>();

  /** `recordPredicates` is every predicate the projection reads from a context graph's metadata. */
  constructor(private readonly recordPredicates: ReadonlySet<string>) {}

  read(contextGraphId: string): string {
    return `${this.everything}:${this.graphs.get(contextGraphId) ?? 0}`;
  }

  /** A write that changes the metadata facts of one context graph. */
  noteFacts(contextGraphId: string): void {
    this.graphs.set(contextGraphId, (this.graphs.get(contextGraphId) ?? 0) + 1);
  }

  /** A write that may have changed the metadata facts of any context graph. */
  noteEverything(): void {
    this.everything += 1;
  }

  /**
   * A removal from a context graph's meta or catalog graph. It is harmless only
   * when it names a subject its facts cannot have (they are about the graph, its
   * sub-graphs and its delegations) or a predicate the projection does not read.
   */
  noteRemoval(contextGraphId: string, { subject, predicate }: StoreRemoval): void {
    if (subject !== undefined && isSafeIri(subject)
      && !subject.startsWith(CONTEXT_GRAPH_PREFIX) && !subject.startsWith(DELEGATION_PREFIX)) return;
    if (predicate !== undefined && isSafeIri(predicate) && !this.recordPredicates.has(predicate)) return;
    this.noteFacts(contextGraphId);
  }
}
