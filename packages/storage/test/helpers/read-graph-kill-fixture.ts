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

/** The write at position `n` of the writer's sequence. */
export function killAtCommitWrite(n: number): (typeof KILL_AT_COMMIT_CYCLE)[number] {
  return KILL_AT_COMMIT_CYCLE[n % KILL_AT_COMMIT_CYCLE.length]!;
}

/**
 * The members that hold the batch once the first `writes` writes have run, in order. Every
 * write changes this set, so the sets before and after a write tell the two apart.
 */
export function killAtCommitHolders(writes: number): number[] {
  const holders = new Set<number>();
  for (let n = 0; n < writes; n += 1) {
    const write = killAtCommitWrite(n);
    if (write.kind === 'insert') holders.add(write.member);
    else holders.delete(write.member);
  }
  return [...holders].sort((left, right) => left - right);
}
