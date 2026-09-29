// SPDX-License-Identifier: Apache-2.0

import { DKGAgentBase } from './dkg-agent-base.js';
import type {
  FinalizedContextGraphAuthorityTargetV1,
  FinalizedContextGraphAuthorityTargetsResolutionV1,
} from './dkg-agent-cg-registry.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import type { OnChainContextGraphFacts } from './context-graph-storage-discovery.js';

/**
 * Chain-public facts attached to a `listContextGraphs` row. Every field is
 * public on chain, including for private graphs; nothing here comes from the
 * local store, so it never reveals a private graph's cleartext name.
 */
export interface ContextGraphListOnChainFacts {
  /** Positive decimal ContextGraphStorage id. */
  readonly id: string;
  /** From the write-once on-chain access policy: 0 = public, 1 = private. */
  readonly access: 'public' | 'private' | 'unknown';
  /** 0 = curated (only the publish authority may publish), 1 = open; null until observed. */
  readonly publishPolicy: 'curated' | 'open' | 'unknown' | null;
  readonly publishAuthority: string | null;
  /** Current ERC-721 owner (the creator unless ownership was transferred); null until observed. */
  readonly owner: string | null;
  /** ISO-8601 creation time from the on-chain timestamp; null until enumerated. */
  readonly createdAt: string | null;
  /** On-chain active flag; `false` once deactivated; null until enumerated. */
  readonly active: boolean | null;
  /** Curator-committed name hash; null when the curator opted out. */
  readonly nameHash: string | null;
  /** Block of the newest observation behind these facts. */
  readonly observedAtBlock: number;
}

/** Project the node's merged on-chain facts onto the list row's `onChain` field. */
export function toContextGraphListOnChainFacts(
  facts: OnChainContextGraphFacts,
): ContextGraphListOnChainFacts {
  return Object.freeze({
    id: facts.onChainId,
    access: facts.accessPolicy === 0 ? 'public' : facts.accessPolicy === 1 ? 'private' : 'unknown',
    publishPolicy: facts.publishPolicy === null
      ? null
      : facts.publishPolicy === 0 ? 'curated' : facts.publishPolicy === 1 ? 'open' : 'unknown',
    publishAuthority: facts.publishAuthority,
    owner: facts.owner,
    createdAt: facts.createdAt === null ? null : new Date(facts.createdAt * 1_000).toISOString(),
    active: facts.active,
    nameHash: facts.nameHash,
    observedAtBlock: facts.observedAtBlock,
  });
}

export type ListContextGraphsRow = {
  id: string;
  uri: string;
  name: string;
  description?: string;
  creator?: string;
  curator?: string;
  accessPolicy?: string;
  createdAt?: string;
  isSystem: boolean;
  subscribed: boolean;
  synced: boolean;
  onChainId?: string;
  callerInvolved?: boolean;
  /**
   * `false` when the node knows this graph only by its on-chain name hash:
   * `id` and `name` are then that hash, never a guessed cleartext. Subscribing
   * by the hash lets the node resolve and verify the cleartext id.
   */
  nameKnown?: boolean;
  /** Chain-public ContextGraphStorage facts, when the node has observed them. */
  onChain?: ContextGraphListOnChainFacts;
};

type ContextGraphListAuthorityAttemptV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: unknown }>;

export type ContextGraphListAuthorityEnrichmentModeV1 =
  | Readonly<{
      kind: 'finalized-index';
      targets: ReadonlyMap<string, FinalizedContextGraphAuthorityTargetV1>;
    }>
  | Readonly<{ kind: 'legacy-current' }>
  | Readonly<{ kind: 'degraded-finalized-index' }>;

export interface ContextGraphListAuthorityEnrichmentOptionsV1 {
  readonly rows: readonly ListContextGraphsRow[];
  readonly readFinalizedTargets: (
    contextGraphIds: readonly string[],
  ) => Promise<ContextGraphListAuthorityAttemptV1<
    FinalizedContextGraphAuthorityTargetsResolutionV1
  >>;
  readonly readRegistrationStatus: (
    contextGraphId: string,
  ) => Promise<ContextGraphListAuthorityAttemptV1<
    'registered' | 'unregistered' | 'pending' | null
  >>;
  readonly readCurrentOnChainId: (
    contextGraphId: string,
  ) => Promise<ContextGraphListAuthorityAttemptV1<string | null>>;
}

async function mapRowsSettled<R>(
  rows: readonly ListContextGraphsRow[],
  fn: (row: ListContextGraphsRow, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(
    rows,
    DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY,
    async (row, index) => {
      try {
        return { status: 'fulfilled', value: await fn(row, index) } as const;
      } catch (reason) {
        return { status: 'rejected', reason } as const;
      }
    },
  );
}

/**
 * Enrich discovered Context Graph rows from one authority mode while preserving
 * the indexed-reader anti-fan-out contract and legacy adapter compatibility.
 */
export async function enrichContextGraphListAuthorityV1(
  options: ContextGraphListAuthorityEnrichmentOptionsV1,
): Promise<Readonly<{
  rows: ListContextGraphsRow[];
  cacheable: boolean;
  mode: ContextGraphListAuthorityEnrichmentModeV1;
}>> {
  let cacheable = true;
  const rowsMissingOnChainId = options.rows.filter((row) => !row.onChainId);
  let mode: ContextGraphListAuthorityEnrichmentModeV1 = {
    kind: 'finalized-index',
    targets: new Map(),
  };
  if (rowsMissingOnChainId.length > 0) {
    try {
      const finalizedRead = await options.readFinalizedTargets(
        rowsMissingOnChainId.map((row) => row.id),
      );
      if (!finalizedRead.ok) {
        cacheable = false;
        mode = { kind: 'degraded-finalized-index' };
      } else {
        mode = finalizedRead.value;
      }
    } catch {
      cacheable = false;
      mode = { kind: 'degraded-finalized-index' };
    }
  }

  const enriched = await mapRowsSettled(options.rows, async (row) => {
    if (row.onChainId) return row;
    if (mode.kind === 'finalized-index') {
      const finalizedTarget = mode.targets.get(row.id);
      // The batch owns one finalized horizon for the complete requested
      // inventory. An omitted target is therefore finalized absence at that
      // horizon, not permission to reopen current-state discovery once per
      // local row. Mixing those horizons both weakens the listing's authority
      // semantics and turns stale durable `registered` markers into a scalar
      // historical-RPC fan-out.
      return finalizedTarget === undefined
        ? row
        : { ...row, onChainId: finalizedTarget.expectedOnChainId.toString(10) };
    }
    // A failed finalized batch is not permission to fan the same failed
    // historical lookup out once per durable row. Leave the entire result
    // visibly uncached and retry one shared read on the next request.
    if (mode.kind === 'degraded-finalized-index') return row;
    const current = await options.readCurrentOnChainId(row.id);
    if (!current.ok) {
      cacheable = false;
      return row;
    }
    return current.value ? { ...row, onChainId: current.value } : row;
  });
  return Object.freeze({
    rows: enriched.map((entry) => {
      if (entry.status === 'fulfilled') return entry.value;
      throw entry.reason;
    }),
    cacheable,
    mode,
  });
}
