import { useCallback, useEffect, useMemo, useState } from 'react';

// Owns ALL of the Create/Renew primary-node selection policy in one place (so the modal just wires
// value/actions to the picker + submit, and sub-PR #2's wallet-managed create reuses it):
//   - renew seed (a replacement starts on the expiring account's primary node),
//   - core convenience default (pre-select this node ONLY when it's actually staked),
//   - list-down best-effort fallback (default to own id; the create-time revert recovery is the net),
//   - stale-default reconcile (a defaulted own id a loaded list doesn't contain is cleared),
//   - rejected-node recovery — the load-bearing invariant: a node the chain rejected
//     (PrimaryNodeNotInShardingTable) is CLEARED, never re-submittable on its numeric shape.

export interface UsePrimaryNodeSelection {
  /** The selected node's identityId ('' = none) — the value Create submits as `primaryNode`. */
  primaryNode: string;
  setPrimaryNode: (id: string) => void;
  /** This node's own identityId WHEN confirmed staked (the cross-check); null otherwise. Drives the
   *  picker's "this node" affordance + the core default. */
  ownStaked: string | null;
  /** A create reverted PrimaryNodeNotInShardingTable: clear the rejected node so it can't be
   *  re-submitted. The prefill re-defaults to the core's own id only if it's still staked. */
  onRejected: () => void;
}

export function usePrimaryNodeSelection(opts: {
  /** Renew (re-mint) seeds the expiring account's primary node; undefined for a fresh create. */
  seedPrimaryNode?: string;
  /** Non-null = renew (re-mint). Renew owns its seed + the revert backstop, so the stale-default
   *  reconcile (below) is fresh-create only. */
  replacingAccountId?: string;
  /** This node's own identityId from /api/status (used only to PRE-SELECT, never to gate). */
  identityId?: string | null;
  /** The loaded staked-node list (drives the staked cross-check + the stale-default reconcile). */
  stakedNodes: readonly { identityId: string }[];
  nodesError: boolean;
  nodesLoading: boolean;
  /** Run the pre-select/reconcile policy only while the create form is active (default true).
   *  The reconcile/success/status-unknown screens don't show the picker, so their effects no-op. */
  enabled?: boolean;
}): UsePrimaryNodeSelection {
  const { seedPrimaryNode, replacingAccountId, identityId, stakedNodes, nodesError, nodesLoading, enabled = true } = opts;
  const [primaryNode, setPrimaryNode] = useState(seedPrimaryNode ?? '');

  // This node's own identity counts as a default ONLY if it's actually IN the staked list
  // (hasIdentity / identityId > 0 alone does NOT imply staked + in the sharding table).
  const ownIdentity = identityId && identityId !== '0' ? String(identityId) : null;
  const ownStaked = useMemo(
    () => (ownIdentity && stakedNodes.some((n) => n.identityId === ownIdentity) ? ownIdentity : null),
    [ownIdentity, stakedNodes],
  );

  // Pre-select (core convenience). Never overrides a seeded (renew) or already-picked value.
  // Pre-select own id only when confirmed staked; if the list is DOWN, core best-effort defaults to
  // its own id (the create-time revert recovery is the backstop). Edge (no own identity) → no default.
  useEffect(() => {
    // Don't (re-)default while a (re)fetch is in flight. After a create-time rejection the modal
    // clears the rejected id AND kicks a FRESH refetch in the same render batch (nodesLoading→true);
    // this guard stops an immediate re-default to the STALE list's own id before the refreshed list
    // (which drops the just-rejected node) arrives — so onRejected's clear holds durably.
    if (!enabled || primaryNode || !ownIdentity || nodesLoading) return;
    if (ownStaked) setPrimaryNode(ownStaked);
    else if (nodesError) setPrimaryNode(ownIdentity);
  }, [enabled, primaryNode, ownIdentity, ownStaked, nodesError, nodesLoading]);

  // Reconcile a STALE best-effort default: a list-down default (primaryNode = ownIdentity) that a
  // successfully-loaded list does NOT contain is invalid → clear it so the picker re-prompts (else
  // submit stays enabled on a bad id until the create-time revert). Fresh-create only. Once the load
  // settles (not loading, not errored) the list is AUTHORITATIVE — including an EMPTY list: an empty
  // table means the own id isn't designatable either, so the default must still be cleared (no
  // length guard, else a 503→own-default then a successful empty retry would keep the bad id).
  useEffect(() => {
    if (!enabled || replacingAccountId || nodesError || nodesLoading) return;
    if (ownIdentity && primaryNode === ownIdentity && !ownStaked) setPrimaryNode('');
  }, [enabled, replacingAccountId, nodesError, nodesLoading, stakedNodes.length, ownIdentity, primaryNode, ownStaked]);

  const onRejected = useCallback(() => setPrimaryNode(''), []);

  return { primaryNode, setPrimaryNode, ownStaked, onRejected };
}
