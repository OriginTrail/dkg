// SPDX-License-Identifier: Apache-2.0

/**
 * When an off-chain on-chain-id claim holds.
 *
 * A `dkg:ContextGraphOnChainId` row says "Context Graph id X is on-chain id
 * N". The `ontology` system graph is shared by every network and deployment,
 * and `_meta` receives what earlier builds left there, so such a row is a
 * claim, never a binding. A claim holds only when slot N on this node's own
 * chain commits X's name commitment, keccak256(utf8(X)): the rule the policy
 * read and random sampling already apply to a local binding
 * (`localContextGraphIdMatchesCommittedNameHash`). The committed hash is the
 * one this node read from its chain (enumeration, the live event tail, or the
 * enumeration checkpoint). A slot with no committed hash proves nothing.
 *
 * This module owns that rule. The agent mixins pass in their state (the
 * per-slot chain facts and the wire-keyed row test) and keep only the
 * stateful wiring.
 */

import {
  isCanonicalAuthoritativeContextGraphId,
  localContextGraphIdMatchesCommittedNameHash,
} from './context-graph-binding-state.js';
import { contextGraphNameCommitmentOf, normalizeContextGraphNameHash } from './context-graph-name-candidate.js';

/** Whether a hash-shaped local id is a row keyed by its own wire id. */
export type IsWireIdKeyedRow = (localId: string) => boolean;

/** A binding this chain proves: the slot, and the name hash it commits. */
export interface ProvenOnChainBinding {
  readonly onChainId: string;
  readonly onChainHash: string;
}

/** The slot facts this module reads: what each on-chain id commits. */
export interface CommittedNameHashes {
  entries(): Iterable<[string, { readonly nameHash: string | null }]>;
  get(onChainId: string): { readonly nameHash: string | null } | undefined;
}

/**
 * The binding a claim names when slot `claimedOnChainId`, committing
 * `committedNameHash`, proves `contextGraphId`; otherwise null.
 */
export function proveOnChainIdClaim(
  contextGraphId: string,
  claimedOnChainId: string,
  committedNameHash: string | null | undefined,
  isWireIdKeyedRow: IsWireIdKeyedRow,
): ProvenOnChainBinding | null {
  if (!isCanonicalAuthoritativeContextGraphId(claimedOnChainId)) return null;
  const committed = normalizeContextGraphNameHash(committedNameHash);
  if (committed === null) return null;
  return localContextGraphIdMatchesCommittedNameHash(contextGraphId, committed, isWireIdKeyedRow)
    ? { onChainId: claimedOnChainId, onChainHash: committed }
    : null;
}

/**
 * Every on-chain id whose committed name hash proves `contextGraphId`:
 * usually one, none when the chain has no such graph or this node has not
 * read it yet. A malformed id proves nothing.
 */
export function provenOnChainIdsFor(
  contextGraphId: string,
  facts: CommittedNameHashes,
  isWireIdKeyedRow: IsWireIdKeyedRow,
): string[] {
  let commitment: string | null;
  try {
    commitment = contextGraphNameCommitmentOf(contextGraphId);
  } catch {
    commitment = null;
  }
  const wireKey = contextGraphId.toLowerCase();
  const proven: string[] = [];
  for (const [onChainId, fact] of facts.entries()) {
    // A cheap exact-match prefilter; `proveOnChainIdClaim` decides.
    const committed = normalizeContextGraphNameHash(fact.nameHash);
    if (committed === null || (committed !== commitment && committed !== wireKey)) continue;
    if (proveOnChainIdClaim(contextGraphId, onChainId, committed, isWireIdKeyedRow) !== null) proven.push(onChainId);
  }
  return proven;
}

/**
 * Whether slot `onChainId`, committing `committedNameHash`, refutes the
 * binding of the row keyed `localId`. Rows with their own lifecycle are
 * never refuted here: a name-hash row (the slot's placeholder, or any row
 * keyed by the committed hash itself), a row recording that commitment, and
 * a row keyed by the bare number (a `dkg subscribe N` row, which the
 * on-chain id resolver retires as a whole while it is still bound to N).
 */
export function refutesOnChainBinding(
  localId: string,
  row: { readonly onChainId?: string; readonly onChainHash?: string },
  onChainId: string,
  committedNameHash: string,
  isWireIdKeyedRow: IsWireIdKeyedRow,
): boolean {
  const committed = normalizeContextGraphNameHash(committedNameHash);
  if (committed === null || row.onChainId !== onChainId || localId === onChainId) return false;
  if (localId.toLowerCase() === committed || isWireIdKeyedRow(localId)) return false;
  if (normalizeContextGraphNameHash(row.onChainHash) === committed) return false;
  return proveOnChainIdClaim(localId, onChainId, committed, isWireIdKeyedRow) === null;
}

/**
 * Whether the row keyed `localId` is the slot's name-hash row that never
 * recorded its hash: keyed by exactly the committed hash, bound to the slot,
 * with no `onChainHash`. Earlier versions minted such a row for
 * `dkg subscribe <hash>` when the hash resolved to nothing.
 */
export function isUnrecordedNameHashRow(
  localId: string,
  row: { readonly onChainId?: string; readonly onChainHash?: string },
  onChainId: string,
  committedNameHash: string,
): boolean {
  const committed = normalizeContextGraphNameHash(committedNameHash);
  return committed !== null
    && localId === committed
    && row.onChainHash === undefined
    && row.onChainId === onChainId;
}
