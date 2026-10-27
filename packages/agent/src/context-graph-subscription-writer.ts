// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';
import type { ContextGraphSubscriptionRollbackSlotRelease } from './context-graph-subscription-authority-recovery.js';
import { projectContextGraphWireAdoption, normalizeContextGraphSubscriptionTransition,
  projectContextGraphSubscriptionPersistence, contextGraphSubscriptionRowsEqual,
  retainsInactiveContextGraphBinding } from './context-graph-subscription-policy.js';

export type ContextGraphSubscriptionWriteOptions = Readonly<{
  persist?: boolean;
  updateRehydrationStatus?: boolean;
  preserveAdmittedWireBinding?: boolean;
  deferWireAdoption?: boolean;
  rollbackSlotRelease?: ContextGraphSubscriptionRollbackSlotRelease;
  retireNamePlaceholder?: boolean;
}>;

export type SubscriptionWriteResult = Readonly<{
  subscription: ContextGraphSub;
  adoptedWire: Readonly<Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainId' | 'onChainHash' | 'coreHosted'>> | undefined;
}>;

/** Deterministic projection only: no collection writes, effects, retained plan or replay API.
 * The lifecycle consumes these facts synchronously in its complete write operation. */
export function projectContextGraphSubscriptionWrite(input: {
  contextGraphId: string;
  previous: ContextGraphSub | undefined;
  next: ContextGraphSubInput;
  wireOnlySubscription: { localId: string; subscription: ContextGraphSub } | null;
  localWireId: string;
  /** Pure canonical hash normalization supplied by the existing identity owner. */
  normalizeWireId(hash: string): string;
  syncScoped: boolean;
  options?: ContextGraphSubscriptionWriteOptions;
}) {
  const { contextGraphId, previous, next, wireOnlySubscription, localWireId, normalizeWireId, options } = input;
  const explicitNextWireId = next.onChainHash === undefined ? undefined : normalizeWireId(next.onChainHash);
  const adoption = projectContextGraphWireAdoption(next,
    options?.deferWireAdoption === true ? undefined : wireOnlySubscription?.subscription,
    localWireId, explicitNextWireId);
  const adoptsWireOnlySubscription = adoption.adopts;
  const normalizedNext = normalizeContextGraphSubscriptionTransition(previous, adoption.next);
  const previousWireId = previous?.onChainHash
    ? normalizeWireId(previous.onChainHash)
    : localWireId;
  const nextOnChainHash = normalizedNext.onChainHash
    ? normalizeWireId(normalizedNext.onChainHash)
    : undefined;
  const nextWireId = nextOnChainHash ?? localWireId;
  const nextRow: ContextGraphSub = {
    ...normalizedNext,
    ...(normalizedNext.onChainHash === nextOnChainHash ? {} : { onChainHash: nextOnChainHash }),
  };
  // A write that changes nothing keeps the stored row. Work in flight holds
  // that object to learn of a change, and a repeated subscribe is not one.
  // A caller that hands the stored row itself back may have changed it in
  // place; what it changed cannot be told, so that write is a new row.
  const canonicalNext = previous !== undefined && next !== previous
    && contextGraphSubscriptionRowsEqual(previous, nextRow)
    ? previous
    : nextRow;
  const adoptedWire = adoptsWireOnlySubscription
    ? { ...wireOnlySubscription!.subscription, id: wireOnlySubscription!.localId } : undefined;
  const retainsInactiveBinding = retainsInactiveContextGraphBinding(previous, canonicalNext);
  return {
    subscription: canonicalNext, adoptedWire, previousWireId, nextWireId, retainsInactiveBinding,
    continuesLine: previous !== undefined && canonicalNext !== previous
      && previous.subscribed === canonicalNext.subscribed
      && (previous.coreHosted === true) === (canonicalNext.coreHosted === true),
    requestsNameResolution: (canonicalNext.subscribed === true || canonicalNext.coreHosted === true)
      && previous?.subscribed !== true && previous?.coreHosted !== true,
    reconcilesResponsibility: previous === undefined
      || previous.subscribed !== canonicalNext.subscribed || previous.coreHosted !== canonicalNext.coreHosted
      || previous.onChainId !== canonicalNext.onChainId || previous.metaSynced !== canonicalNext.metaSynced,
    persistence: projectContextGraphSubscriptionPersistence({ contextGraphId, subscription: canonicalNext,
      syncScoped: input.syncScoped, preserveInactiveIntent: options?.persist !== true && retainsInactiveBinding
        && previous?.subscribed !== true && previous?.coreHosted !== true }),
  } as const;
}
