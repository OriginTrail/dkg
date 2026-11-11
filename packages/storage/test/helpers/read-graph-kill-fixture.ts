import type { Quad } from '../../src/triple-store.js';

/** The agent whose verifiable-memory graphs the kill-at-commit writer fills. */
export const KILL_AT_COMMIT_AGENT = '0x' + 'cd'.repeat(20);

/** The n-th member graph of the context graph's verifiable-memory read graph. */
export function killAtCommitMember(contextGraphId: string, n: number): string {
  return `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${KILL_AT_COMMIT_AGENT}/${n}`;
}

/** One write: the same triples whatever the graph, so members share them and a delete has to check the others. */
export function killAtCommitBatch(graph: string, size: number): Quad[] {
  return Array.from({ length: size }, (_, i) => ({ subject: `urn:kill:${i}`, predicate: 'urn:kill:p', object: `"v${i}"`, graph }));
}
