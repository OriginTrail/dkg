// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';

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
