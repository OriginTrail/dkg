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

/**
 * The writer's writes, repeated: the batch goes into two members, leaves one while the other
 * keeps it, goes into a third, leaves the second while the third keeps it, then leaves its last
 * member. A kill can therefore interrupt a delete that must keep the batch in the read graph, and
 * the delete of its last copy.
 */
export const KILL_AT_COMMIT_CYCLE: ReadonlyArray<{ readonly kind: 'insert' | 'delete'; readonly member: number }> = [
  { kind: 'insert', member: 0 }, { kind: 'insert', member: 1 }, { kind: 'delete', member: 0 },
  { kind: 'insert', member: 2 }, { kind: 'delete', member: 1 }, { kind: 'delete', member: 2 },
];

/** Whether write `n` is a delete while another member keeps the batch, whatever the kill interrupted. */
export function killAtCommitKeepsBatch(n: number): boolean {
  const step = n % KILL_AT_COMMIT_CYCLE.length;
  return step === 2 || step === 4;
}
