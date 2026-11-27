// SPDX-License-Identifier: Apache-2.0
/**
 * The last steps of a context graph listing, shared by the default listing and
 * the projection listing: set aside the rows the node knows only by their
 * on-chain name hash, apply the caller's opt-in filter (#3919), and attach the
 * additive `nameKnown` and `onChain` fields.
 */
import {
  toContextGraphListOnChainFacts,
  type ListContextGraphsRow,
} from './context-graph-list-authority-enrichment.js';
import type { OnChainContextGraphFacts } from './context-graph-storage-discovery.js';

/**
 * Opt-in narrowing of a listing (#3919). A field that is left out keeps the
 * full answer, so `undefined` and `{}` list exactly what a listing always did.
 */
export interface ContextGraphListFilter {
  /**
   * `true` lists only the rows the node knows by name (`nameKnown: true`),
   * and skips the rows it knows only by their on-chain name hash before
   * reading anything more about them.
   */
  readonly namedOnly?: boolean;
  /** `false` leaves out the system graphs (`isSystem: true`). */
  readonly includeSystem?: boolean;
  /** `false` leaves the `onChain` facts out of every row, unread. */
  readonly includeOnChain?: boolean;
}

/** A filter with every field decided; see {@link normalizeContextGraphListFilter}. */
export type NormalizedContextGraphListFilter = Readonly<Required<ContextGraphListFilter>>;

/** The filter of a listing that asks for no narrowing: the full answer. */
export const UNFILTERED_CONTEXT_GRAPH_LIST: NormalizedContextGraphListFilter = Object.freeze({
  namedOnly: false,
  includeSystem: true,
  includeOnChain: true,
});

/** Decide every field; only an exact boolean narrows the answer. */
export function normalizeContextGraphListFilter(
  filter: ContextGraphListFilter | undefined,
): NormalizedContextGraphListFilter {
  return Object.freeze({
    namedOnly: filter?.namedOnly === true,
    includeSystem: filter?.includeSystem !== false,
    includeOnChain: filter?.includeOnChain !== false,
  });
}

/**
 * The part of a per-caller cache key that keeps differently filtered answers
 * apart. It is empty for the full answer, so an unfiltered listing keeps the
 * cache key it always had.
 */
export function contextGraphListFilterCacheKey(filter: NormalizedContextGraphListFilter): string {
  if (!filter.namedOnly && filter.includeSystem && filter.includeOnChain) return '';
  return `|named=${filter.namedOnly}|system=${filter.includeSystem}|onChain=${filter.includeOnChain}`;
}

/**
 * The agent state that tells a hash-only row apart and carries its chain
 * facts. Listing methods pass their own maps in, so a renamed field fails to
 * compile rather than silently changing what is listed.
 */
export interface ContextGraphListChainState {
  readonly subscribedContextGraphs: ReadonlyMap<string, { readonly onChainHash?: string }>;
  readonly wireIdToLocalCgId: ReadonlyMap<string, string>;
  readonly onChainContextGraphFacts: ReadonlyMap<string, OnChainContextGraphFacts>;
}

/**
 * True for a row the node knows only by its on-chain name hash: the local id
 * is the committed wire id itself, with no cleartext behind it. This is the
 * canonical subscription setter's placeholder predicate (the row claims that
 * exact `onChainHash` and the reverse index points at it), so a user-chosen
 * cleartext id that merely looks like a hash never matches.
 */
export function isWireOnlyContextGraphListRow(state: ContextGraphListChainState, contextGraphId: string): boolean {
  if (!/^0x[0-9a-f]{64}$/.test(contextGraphId)) return false;
  return state.subscribedContextGraphs.get(contextGraphId)?.onChainHash?.toLowerCase() === contextGraphId
    && state.wireIdToLocalCgId.get(contextGraphId) === contextGraphId;
}

/**
 * Set aside the rows the node knows only by their on-chain name hash. Both
 * listing paths apply privacy and caller annotation to the local rows alone
 * and list every wire-only row for every caller, reduced to chain-public
 * facts by {@link annotateContextGraphListRows}.
 *
 * The filter applies here, before privacy and caller annotation: a named-only
 * listing drops the wire-only rows and a listing without system graphs drops
 * those, so the node never annotates a row it then leaves out. A wire-only row
 * is listed with `isSystem: false`, so it stays in a listing without system
 * graphs.
 */
export function partitionWireOnlyContextGraphListRows<Row extends { id: string; isSystem: boolean }>(
  rows: readonly Row[],
  state: ContextGraphListChainState,
  filter: NormalizedContextGraphListFilter = UNFILTERED_CONTEXT_GRAPH_LIST,
): { local: Row[]; wireOnly: Row[] } {
  const local: Row[] = [];
  const wireOnly: Row[] = [];
  for (const row of rows) {
    if (isWireOnlyContextGraphListRow(state, row.id)) {
      if (!filter.namedOnly) wireOnly.push(row);
    } else if (filter.includeSystem || !row.isSystem) {
      local.push(row);
    }
  }
  return { local, wireOnly };
}

/**
 * The listed rows: the visible local rows, then the wire-only rows, each with
 * the additive `nameKnown` and `onChain` fields. A filter without chain facts
 * leaves `onChain` out and never reads the facts index.
 *
 * `onChain` holds chain-public facts only (see ContextGraphListOnChainFacts).
 * A wire-only row is reduced to those facts: its name stays the hash and no
 * locally projected field survives, so listing it for every caller never
 * reveals more than the chain already publishes, including for a private
 * graph. A cleartext name is shown only for rows the node itself indexes under
 * that name (created, joined, adopted after keccak verification, or a local
 * definition whose commitment matched); it is never guessed.
 */
export function annotateContextGraphListRows(
  visibleLocal: readonly ListContextGraphsRow[],
  wireOnly: readonly ListContextGraphsRow[],
  state: ContextGraphListChainState,
  filter: NormalizedContextGraphListFilter = UNFILTERED_CONTEXT_GRAPH_LIST,
): ListContextGraphsRow[] {
  const withChainFacts = (row: ListContextGraphsRow, nameKnown: boolean): ListContextGraphsRow => {
    const facts = filter.includeOnChain && row.onChainId
      ? state.onChainContextGraphFacts.get(row.onChainId)
      : undefined;
    return {
      ...row,
      nameKnown,
      ...(facts ? { onChain: toContextGraphListOnChainFacts(facts) } : {}),
    };
  };
  return [
    ...visibleLocal.map((row) => withChainFacts(row, true)),
    ...wireOnly.map((row) => withChainFacts({
      id: row.id,
      uri: row.uri,
      name: row.id,
      isSystem: false,
      subscribed: row.subscribed,
      synced: row.synced,
      ...(row.onChainId ? { onChainId: row.onChainId } : {}),
    }, false)),
  ];
}
