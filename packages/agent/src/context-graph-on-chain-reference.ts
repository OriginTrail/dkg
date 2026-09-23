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

/**
 * Use the input as given: it is not an on-chain id, it is a bare number that
 * keys a subscription the chain does not prove wrong, or the node has no
 * chain (a bare number is then just a name).
 */
export interface ContextGraphIdAsGiven {
  readonly kind: 'as-given';
}

/** An on-chain id and the row this node keeps for its graph. */
export interface ResolvedContextGraphOnChainId {
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

/**
 * Why an on-chain id cannot be subscribed. `private` is decided from a
 * resolved graph by {@link refusesPrivateContextGraphByOnChainId}; the
 * resolver reports every other refusal itself.
 */
export type ContextGraphOnChainIdRefusal =
  | { readonly kind: 'not-found'; readonly onChainId: string; readonly latestId: string }
  | { readonly kind: 'inactive'; readonly onChainId: string }
  | { readonly kind: 'no-name-hash'; readonly onChainId: string }
  | { readonly kind: 'private'; readonly onChainId: string }
  | { readonly kind: 'unavailable'; readonly onChainId: string; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly onChainId: string };

/** What a subscription request's id resolved to. */
export type ContextGraphOnChainIdResolution =
  | ContextGraphIdAsGiven
  | ResolvedContextGraphOnChainId
  | Exclude<ContextGraphOnChainIdRefusal, { kind: 'private' }>;

/**
 * What an id names among the rows this node already keeps, without reading
 * the chain: for unsubscribing and for status lookups.
 */
export type ContextGraphOnChainIdLookup =
  | ContextGraphIdAsGiven
  | {
      readonly kind: 'held';
      readonly onChainId: string;
      /** The row this node keeps for the graph: its verified cleartext id, or the name hash. */
      readonly contextGraphId: string;
      readonly nameHash: string;
    }
  /** An on-chain id this node keeps no row for. */
  | { readonly kind: 'not-held'; readonly onChainId: string };

/**
 * The one rule for a private graph named by its on-chain id. Peers never
 * reveal a private graph's cleartext id, so a node that holds only its name
 * hash has nothing anyone can subscribe, and refuses every caller. A node
 * that holds the cleartext id (a member, or the curator) refuses a caller
 * whose read authority is denied, with the same answer, so that caller
 * cannot tell which case applied. `admission` is the caller's read-authority
 * outcome for the resolved row, and is omitted where no caller is involved
 * (start-up configuration is the operator's own intent).
 */
export function refusesPrivateContextGraphByOnChainId(
  resolution: ResolvedContextGraphOnChainId,
  admission?: 'allowed' | 'denied' | 'unavailable',
): boolean {
  return resolution.private
    && (resolution.contextGraphId === resolution.nameHash || admission === 'denied');
}

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
export function describeContextGraphOnChainIdResolution(
  resolution: ResolvedContextGraphOnChainId | ContextGraphOnChainIdRefusal,
): string {
  const id = `#${resolution.onChainId}`;
  switch (resolution.kind) {
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
