// SPDX-License-Identifier: Apache-2.0

/**
 * A Context Graph's on-chain numeric id (`32`, `#32`) as operator input.
 *
 * ContextGraphStorage mints sequential ids, and `dkg context-graph list` shows
 * them, so users type them. An on-chain id is not a Context Graph id, though:
 * holders key a graph by its cleartext id, and gossip topics and wire ids
 * derive from its name hash. A subscription keyed "32" derives both from
 * keccak256("32") and matches nothing. An on-chain id is therefore only a
 * lookup key. It resolves to the row this node keeps for that graph, which is
 * the verified cleartext id or the hash-keyed row that discovery staged, and
 * never becomes a subscription key itself.
 *
 * This module holds the pure parts: the syntax and the operator-facing text.
 * The lookup lives in dkg-agent-cg-on-chain-id.ts.
 */

import { isCanonicalAuthoritativeContextGraphId } from './context-graph-binding-state.js';

export interface ContextGraphOnChainIdReference {
  /** Canonical positive decimal ContextGraphStorage id. */
  readonly onChainId: string;
  /**
   * The input was `#N` or a JSON number. `#` is not a Context Graph id
   * character, so only the bare decimal form can also be a literal key.
   */
  readonly explicit: boolean;
}

/**
 * `32`, `#32` or the JSON number 32 names on-chain Context Graph 32; anything
 * else is not an on-chain id. Only canonical decimals within uint256 count, so
 * `032` or `#0` stay ordinary (invalid) ids.
 */
export function parseContextGraphOnChainIdReference(value: unknown): ContextGraphOnChainIdReference | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? { onChainId: String(value), explicit: true } : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const explicit = trimmed.startsWith('#');
  const digits = explicit ? trimmed.slice(1) : trimmed;
  return isCanonicalAuthoritativeContextGraphId(digits) ? { onChainId: digits, explicit } : null;
}

/** What an on-chain id resolved to. */
export type ContextGraphOnChainIdResolution =
  /** A subscription keyed by the literal bare number exists and is not a proven alias: it wins. */
  | { readonly kind: 'direct'; readonly onChainId: string }
  | {
      readonly kind: 'resolved';
      readonly onChainId: string;
      readonly nameHash: string;
      /** The row this node keeps for the graph: its verified cleartext id, or the name hash. */
      readonly contextGraphId: string;
      /** The graph is private (curated access); only then can this node hold its cleartext as a member. */
      readonly private: boolean;
      /** A subscription keyed by the bare number that this resolution retired. */
      readonly retiredNumericSubscription?: RetiredNumericContextGraphSubscription;
    }
  | { readonly kind: 'not-found'; readonly onChainId: string; readonly latestId: string }
  | { readonly kind: 'inactive'; readonly onChainId: string }
  | { readonly kind: 'no-name-hash'; readonly onChainId: string }
  | { readonly kind: 'private'; readonly onChainId: string }
  | { readonly kind: 'unavailable'; readonly onChainId: string; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly onChainId: string };

/** The member intent a retired numeric subscription carried. */
export interface RetiredNumericContextGraphSubscription {
  readonly contextGraphId: string;
  readonly subscribed: boolean;
  readonly syncMode: 'on-demand' | 'always-on';
}

function shortHash(nameHash: string): string {
  return `${nameHash.slice(0, 10)}…${nameHash.slice(-4)}`;
}

/** One operator-facing sentence per outcome, shared by the API, the CLI and startup logs. */
export function describeContextGraphOnChainIdResolution(resolution: ContextGraphOnChainIdResolution): string {
  const id = `#${resolution.onChainId}`;
  switch (resolution.kind) {
    case 'direct':
      return `"${resolution.onChainId}" is an existing subscription key on this node; it is used as given `
        + `(write '${id}' for on-chain Context Graph ${resolution.onChainId}).`;
    case 'resolved': {
      const graph = resolution.contextGraphId === resolution.nameHash
        ? `On-chain Context Graph ${id} is Context Graph ${shortHash(resolution.nameHash)} (its on-chain name hash).`
        : `On-chain Context Graph ${id} is "${resolution.contextGraphId}" (verified against its on-chain name hash).`;
      return resolution.retiredNumericSubscription === undefined
        ? graph
        : `${graph} Retired the subscription keyed "${resolution.onChainId}", which could never sync.`;
    }
    case 'not-found':
      return `Context Graph ${id} does not exist on chain: the latest Context Graph id is ${resolution.latestId}. `
        + 'A graph created moments ago appears once its creation block is final.';
    case 'inactive':
      return `Context Graph ${id} is deactivated on chain and can no longer be subscribed.`;
    case 'no-name-hash':
      return `Context Graph ${id} has no on-chain name hash (its creator opted out), so this node cannot derive `
        + 'or verify its Context Graph id from the chain. Subscribe with the Context Graph id its curator shares.';
    case 'private':
      return `Context Graph ${id} is private (curated access): only its members can subscribe. `
        + 'Ask its curator for an invitation and the Context Graph id, then subscribe with that id.';
    case 'unavailable':
      return `Could not read Context Graph ${id} from ContextGraphStorage (${resolution.detail}); `
        + 'retry once the chain RPC responds.';
    case 'unsupported':
      return `This node cannot read ContextGraphStorage, so it cannot resolve on-chain id ${id}. `
        + 'Subscribe with the Context Graph id or its name hash.';
  }
}
