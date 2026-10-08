// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';
import {
  contextGraphNameCommitmentOf, normalizeContextGraphNameHash, verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';

export type ContextGraphNameHashBindingTarget = {
  localId: string;
  subscription: ContextGraphSub;
  nameHash?: string;
};

export interface ContextGraphNameBindingTargetSource {
  subscriptions: ReadonlyMap<string, ContextGraphSub>;
  localIdForWireId(wireId: string): string;
  wireId(id: string): string;
  nameCommitment(id: string): string;
  isWireIdKeyedSubscription(id: string): boolean;
}

/** Direct keys preserve literal names, including names that look like bytes32. */
export function resolveContextGraphNameBindingTarget(
  source: ContextGraphNameBindingTargetSource,
  requestedId: string,
): ContextGraphNameHashBindingTarget | null {
  const direct = source.subscriptions.get(requestedId);
  const mappedLocalId = source.localIdForWireId(source.wireId(requestedId));
  const localId = direct === undefined ? mappedLocalId : requestedId;
  const subscription = direct ?? source.subscriptions.get(mappedLocalId);
  if (subscription === undefined) return null;

  // A wire-only discovery row owns its slot, not every cleartext preimage of
  // its commitment. Keep it out of all indirect identity/authority consumers;
  // exact durable hints or the requested graph's strict resolver own that name.
  if (localId !== requestedId
    && source.isWireIdKeyedSubscription(localId)
    && source.nameCommitment(requestedId) === source.wireId(localId)) return null;

  const locallyAdmitted = subscription.subscribed === true
    || subscription.coreHosted === true;
  const nameHash = locallyAdmitted
    ? subscription.onChainHash
      ? source.wireId(subscription.onChainHash)
      : source.nameCommitment(localId)
    : undefined;
  return { localId, subscription, nameHash };
}

/** Exact numeric selection is independent of the single wire-routing owner. */
export function resolveRetainedContextGraphNumericBinding(
  subscriptions: ReadonlyMap<string, ContextGraphSub>,
  wireOwners: ReadonlyMap<string, string>,
  onChainId: string,
  committedNameHash?: string,
): { contextGraphId: string; nameHash: string } | null {
  const committed = normalizeContextGraphNameHash(committedNameHash);
  if (committedNameHash !== undefined && committed === null) return null;
  let held: { contextGraphId: string; nameHash: string } | null = null;
  let admitted: { contextGraphId: string; nameHash: string } | null = null;
  let ambiguous = false;
  for (const [contextGraphId, row] of subscriptions) {
    if (row.onChainId !== onChainId) continue;
    const explicit = normalizeContextGraphNameHash(row.onChainHash);
    if (row.onChainHash !== undefined && explicit === null) continue;
    let nameHash: string;
    try {
      nameHash = committed ?? explicit ?? contextGraphNameCommitmentOf(contextGraphId);
    } catch {
      continue;
    }
    if (explicit !== null && explicit !== nameHash) continue;
    const wirePlaceholder = explicit === nameHash
      && normalizeContextGraphNameHash(contextGraphId) === nameHash;
    if (!wirePlaceholder
      && verifyContextGraphNameCandidate(contextGraphId, nameHash) !== contextGraphId) continue;
    if (held !== null && held.nameHash !== nameHash) return null;
    const candidate: { contextGraphId: string; nameHash: string } = { contextGraphId, nameHash };
    if (wireOwners.get(nameHash) === contextGraphId
      && (row.subscribed === true || row.coreHosted === true)) admitted = candidate;
    if (held !== null) ambiguous = true;
    else held = candidate;
  }
  return admitted ?? (ambiguous ? null : held);
}
