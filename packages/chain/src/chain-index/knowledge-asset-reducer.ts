// SPDX-License-Identifier: Apache-2.0

/**
 * The knowledge-asset reducers over the ONE log.
 *
 * Three folds, all of them pure and all of them over rows the tick already
 * fetched: the per-graph KA list (ordinal + unique `kaId`), the per-KA merkle
 * root stack (root, author, rootIndex), and the per-author allocator floor.
 * Nothing here reads a chain; if a fold cannot answer, it says so and the
 * caller goes live.
 *
 * CONTAINMENT (architecture review, required change 4). A fold error is scoped
 * to the ONE entity it concerns and never throws for the page. Before this log
 * existed, a malformed event broke the RFC-64 reads alone; once every KA read
 * folds here, one bad row throwing for the page would refuse every KA on the
 * node. An entity the fold cannot trust is marked unservable instead, which
 * routes exactly that entity back to `eth_call`.
 */

import type {
  ContextGraphKaRegistration,
  KnowledgeAssetEvent,
} from './chain-event-decoders.js';

/** One version of a KA's root, at its position in the on-chain stack. */
export interface KnowledgeAssetRootVersion {
  readonly merkleRoot: string;
  /** `DKGKnowledgeAssets.merkleRootAuthors`; absent for the admin push path. */
  readonly author?: string;
  /** Contract gap #2674 — only the unused admin replacement carries this. */
  readonly publisher?: string;
}

export interface KnowledgeAssetRootStack {
  readonly kaId: bigint;
  /** Oldest first. `getLatestMerkleRoot` is the last entry. */
  readonly versions: readonly KnowledgeAssetRootVersion[];
  /**
   * Highest block that contributed to this stack. A read-your-writes barrier
   * compares against this, never against the cursor: the cursor can be past a
   * block this KA had no event in.
   */
  readonly throughBlockNumber: number;
  /**
   * Why this KA may not be served, if it may not be.
   *
   * `missing-history` is the honest answer for a root stack whose bottom was
   * never seen — a `…MerkleRootRemoved` under partial coverage cannot name the
   * root it exposes underneath, and guessing it would hand a verifier a root
   * the chain does not hold.
   */
  readonly unservable?: 'missing-history' | 'inconsistent';
}

export interface ContextGraphKaList {
  readonly contextGraphId: bigint;
  /** Position IS `getContextGraphKaAt(cg, i)`; the on-chain list never reorders. */
  readonly kaIds: readonly bigint[];
  readonly throughBlockNumber: number;
}

/** OT-RFC-43 Option 1: the per-author ordinal is the low 96 bits of the id. */
const KA_NUMBER_MASK = (1n << 96n) - 1n;

/**
 * Fold registrations into per-graph lists and the `kaToContextGraph` memo.
 *
 * Rows MUST arrive in (blockNumber, logIndex) order and MUST cover a
 * contiguous range the caller has proven with {@link chainEventLogCoverageIncludes};
 * an ordinal is only correct if nothing before it was skipped.
 */
export function reduceContextGraphKaRegistrations(
  events: readonly ContextGraphKaRegistration[],
): Readonly<{
  listsByContextGraph: ReadonlyMap<string, ContextGraphKaList>;
  contextGraphByKa: ReadonlyMap<string, bigint>;
  throughBlockNumber: number;
}> {
  const kaIdsByGraph = new Map<string, bigint[]>();
  const throughByGraph = new Map<string, number>();
  const contextGraphByKa = new Map<string, bigint>();
  // UNIQUE ka_id. `ContextGraphStorage` reverts a second registration
  // (:355-358), so a repeat here is the log replaying a row, not the chain
  // binding a KA twice. Appending it would shift every later ordinal by one
  // and make `getContextGraphKaAt` disagree with the chain from there on.
  const seenKaIds = new Set<string>();
  let throughBlockNumber = 0;

  for (const event of events) {
    throughBlockNumber = Math.max(throughBlockNumber, event.blockNumber);
    const kaKey = event.kaId.toString();
    if (seenKaIds.has(kaKey)) continue;
    seenKaIds.add(kaKey);
    contextGraphByKa.set(kaKey, event.contextGraphId);
    const graphKey = event.contextGraphId.toString();
    const list = kaIdsByGraph.get(graphKey) ?? [];
    list.push(event.kaId);
    kaIdsByGraph.set(graphKey, list);
    throughByGraph.set(graphKey, Math.max(throughByGraph.get(graphKey) ?? 0, event.blockNumber));
  }

  const listsByContextGraph = new Map<string, ContextGraphKaList>();
  for (const [graphKey, kaIds] of kaIdsByGraph) {
    listsByContextGraph.set(graphKey, Object.freeze({
      contextGraphId: BigInt(graphKey),
      kaIds: Object.freeze([...kaIds]),
      throughBlockNumber: throughByGraph.get(graphKey) ?? 0,
    }));
  }

  return Object.freeze({
    listsByContextGraph,
    contextGraphByKa,
    throughBlockNumber,
  });
}

/**
 * Fold the five root signatures into a per-KA stack, and the creates into the
 * allocator floor.
 *
 * The stack is kept whole rather than collapsed to "the latest root" because
 * `…MerkleRootRemoved` names the root it REMOVES, not the one it exposes: only
 * the history below it can say what `getLatestMerkleRoot` returns afterwards.
 */
export function reduceKnowledgeAssetEvents(
  events: readonly KnowledgeAssetEvent[],
): Readonly<{
  rootsByKa: ReadonlyMap<string, KnowledgeAssetRootStack>;
  maxKaNumberByAuthor: ReadonlyMap<string, bigint>;
  /**
   * Creates in this fold that carried no decodable author.
   *
   * `maxKaNumberByAuthor` is only populated for creates that HAVE an author, so
   * an ABI whose `KnowledgeAssetCreated` never yields one folds silently to an
   * empty map — and an empty map under complete coverage reads as a floor of
   * zero, which hands out a KA number that is already taken. Complete coverage
   * is the wrong property to gate the floor on; this is the right one.
   */
  authorlessCreates: number;
  throughBlockNumber: number;
}> {
  interface MutableStack {
    versions: KnowledgeAssetRootVersion[];
    throughBlockNumber: number;
    createdSeen: boolean;
    unservable?: 'missing-history' | 'inconsistent';
  }
  const stacks = new Map<string, MutableStack>();
  const maxKaNumberByAuthor = new Map<string, bigint>();
  let authorlessCreates = 0;
  let throughBlockNumber = 0;

  const stackFor = (kaId: bigint): MutableStack => {
    const key = kaId.toString();
    let stack = stacks.get(key);
    if (stack === undefined) {
      stack = { versions: [], throughBlockNumber: 0, createdSeen: false };
      stacks.set(key, stack);
    }
    return stack;
  };

  for (const event of events) {
    throughBlockNumber = Math.max(throughBlockNumber, event.blockNumber);
    const stack = stackFor(event.kaId);
    stack.throughBlockNumber = Math.max(stack.throughBlockNumber, event.blockNumber);

    switch (event.name) {
      case 'KnowledgeAssetCreated': {
        if (event.merkleRoot === undefined) {
          stack.unservable = 'inconsistent';
          break;
        }
        // The create is the bottom of the stack by construction, so seeing it
        // is what turns a partial fold into a complete one for THIS KA.
        stack.versions = [Object.freeze({
          merkleRoot: event.merkleRoot,
          ...(event.author === undefined ? {} : { author: event.author }),
        })];
        stack.createdSeen = true;
        if (event.author === undefined) {
          authorlessCreates += 1;
        } else {
          const number = event.kaId & KA_NUMBER_MASK;
          const held = maxKaNumberByAuthor.get(event.author);
          if (held === undefined || number > held) maxKaNumberByAuthor.set(event.author, number);
        }
        break;
      }
      case 'KnowledgeAssetUpdated':
      case 'KnowledgeAssetMerkleRootAdded': {
        if (event.merkleRoot === undefined) {
          stack.unservable = 'inconsistent';
          break;
        }
        stack.versions.push(Object.freeze({
          merkleRoot: event.merkleRoot,
          ...(event.author === undefined ? {} : { author: event.author }),
        }));
        break;
      }
      case 'KnowledgeAssetMerkleRootRemoved': {
        const top = stack.versions[stack.versions.length - 1];
        if (top === undefined || top.merkleRoot !== event.merkleRoot) {
          // Either history below this point was never walked, or the stack the
          // fold holds is not the stack the chain holds. Both mean the same
          // thing to a caller: ask the chain.
          stack.unservable = 'missing-history';
          break;
        }
        stack.versions.pop();
        break;
      }
      case 'KnowledgeAssetMerkleRootsUpdated': {
        // Absent means the decoder could not read the list WHOLE: one entry it
        // cannot normalize voids the event
        // (`chain-event-decoders.ts:decodeMerkleRootEntries`), because a
        // partial replacement is a DIFFERENT stack rather than a shorter one —
        // wrong top root, every `rootIndex` shifted. Unservable, not partial.
        const replacement = event.merkleRoots ?? [];
        if (replacement.length === 0) {
          stack.unservable = 'inconsistent';
          break;
        }
        stack.versions = replacement.map((entry) => Object.freeze({
          merkleRoot: entry.merkleRoot,
          ...(entry.publisher === undefined ? {} : { publisher: entry.publisher }),
        }));
        // A whole-stack replacement re-establishes the bottom: every version
        // the chain holds is named in this one event.
        stack.createdSeen = true;
        break;
      }
      /* c8 ignore next 2 -- the decoder only produces the five names above. */
      default:
        break;
    }
  }

  const rootsByKa = new Map<string, KnowledgeAssetRootStack>();
  for (const [key, stack] of stacks) {
    // No create and no replacement means the fold is looking at the middle of
    // a history. `rootIndex` would be wrong even when the top root is right.
    const unservable = stack.unservable ?? (stack.createdSeen ? undefined : 'missing-history');
    rootsByKa.set(key, Object.freeze({
      kaId: BigInt(key),
      versions: Object.freeze([...stack.versions]),
      throughBlockNumber: stack.throughBlockNumber,
      ...(unservable === undefined ? {} : { unservable }),
    }));
  }

  return Object.freeze({
    rootsByKa,
    maxKaNumberByAuthor,
    authorlessCreates,
    throughBlockNumber,
  });
}

/** `getLatestMerkleRoot` plus the `rootIndex` that names its version. */
export function latestMerkleRootOf(
  stack: KnowledgeAssetRootStack | undefined,
): Readonly<{ merkleRoot: string; rootIndex: number; author?: string }> | undefined {
  if (stack === undefined || stack.unservable !== undefined) return undefined;
  const latest = stack.versions[stack.versions.length - 1];
  if (latest === undefined) return undefined;
  return Object.freeze({
    merkleRoot: latest.merkleRoot,
    rootIndex: stack.versions.length - 1,
    ...(latest.author === undefined ? {} : { author: latest.author }),
  });
}
