// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord, ContextGraphSubscriptionRehydrationInternalStatus } from './dkg-agent-types.js';
import type { ContextGraphSubscriptionRollbackSlotRelease } from './context-graph-subscription-authority-recovery.js';
import type { ContextGraphBindingSubscriptionFacts } from './context-graph-binding-state.js';
import { rehydratedSubscriptionReachedSafeState } from './context-graph-subscription-authority-recovery.js';
import { projectContextGraphWireAdoption, normalizeContextGraphSubscriptionTransition,
  projectContextGraphSubscriptionPersistence, contextGraphSubscriptionRowsEqual,
  continueContextGraphSubscriptionLine, retainsInactiveContextGraphBinding } from './context-graph-subscription-policy.js';

export type ContextGraphSubscriptionWriteOptions = Readonly<{
  persist?: boolean;
  updateRehydrationStatus?: boolean;
  preserveAdmittedWireBinding?: boolean;
  deferWireAdoption?: boolean;
  rollbackSlotRelease?: ContextGraphSubscriptionRollbackSlotRelease;
  retireNamePlaceholder?: boolean;
}>;

/** Internal data shared by the effects of one synchronous canonical write. */
type ContextGraphSubscriptionWriteTransition = Readonly<{
  contextGraphId: string;
  source: ContextGraphSub | undefined;
  subscription: ContextGraphSub;
  adoptedWire: Readonly<Pick<ContextGraphSubscriptionRecord, 'id' | 'onChainId' | 'onChainHash' | 'coreHosted'>> | undefined;
  options: ContextGraphSubscriptionWriteOptions;
}>;

export type SubscriptionWriteResult = Pick<ContextGraphSubscriptionWriteTransition, 'subscription' | 'adoptedWire'>;
interface SubscriptionWritePorts {
  subscriptions: Map<string, ContextGraphSub>;
  wireOwners: Map<string, string>;
  accountedIds: ReadonlySet<string>;
  slots: Set<string>;
  nameCommitment(id: string): string;
  wireId(hash: string): string;
  wirePredecessor(id: string): { localId: string; subscription: ContextGraphSub } | null;
  applyBinding(id: string, previous: ContextGraphSub | undefined, next: ContextGraphSub, wireId: string): ContextGraphBindingSubscriptionFacts;
  requestNameResolution(id: string): void;
  invalidateLists(): void;
  retireNamePlaceholder(id: string): void;
  deleteSubscription(id: string): boolean;
  info(phase: 'system' | 'init', message: string): void;
  rehydrationStatus(): ContextGraphSubscriptionRehydrationInternalStatus | null;
  releaseSlot(id: string, reason: 'readiness' | 'deactivation' | ContextGraphSubscriptionRollbackSlotRelease): boolean;
  receiverSelected(id: string): boolean;
  isEdge(): boolean;
  receiverSelectionChanged(id: string, change: { kind: 'subscription'; previousSubscribed: boolean; nextSubscribed: boolean }): void;
  reconcileResponsibility(id: string): void;
  forceClearVmState(id: string): void;
  clearVmState(id: string): void;
  syncScoped(id: string): boolean;
  hasStore(): boolean;
  nextPersistRevision(id: string): number;
  persist(id: string, options: { revision: number; preserveDormantHosting: boolean;
    retiredNamePredecessor: SubscriptionWriteResult['adoptedWire']; updateRehydrationStatus: boolean }): Promise<void>;
  persistMembership(id: string): void;
  removeMembership(id: string): void;
}

/** Project, validate and apply one canonical write without yielding ownership. */
export function writeContextGraphSubscription(ports: SubscriptionWritePorts,
  contextGraphId: string,
  next: ContextGraphSubInput,
  options?: ContextGraphSubscriptionWriteOptions,
): SubscriptionWriteResult {
  const previous = ports.subscriptions.get(contextGraphId);
  // A local id is always cleartext unless the subscription explicitly says
  // otherwise through `onChainHash`. This distinction matters for a valid
  // user-chosen id that happens to match the 0x+64-hex wire-id shape.
  const localWireId = ports.nameCommitment(contextGraphId);
  const wireOnlySubscription =
    ports.wirePredecessor(contextGraphId);
  const explicitNextWireId = next.onChainHash === undefined
    ? undefined
    : ports.wireId(next.onChainHash);
  const adoption = projectContextGraphWireAdoption(next,
    options?.deferWireAdoption === true ? undefined : wireOnlySubscription?.subscription,
    localWireId, explicitNextWireId);
  const adoptsWireOnlySubscription = adoption.adopts;
  const normalizedNext = normalizeContextGraphSubscriptionTransition(previous, adoption.next);
  const previousWireId = previous?.onChainHash
    ? ports.wireId(previous.onChainHash)
    : localWireId;
  const nextOnChainHash = normalizedNext.onChainHash
    ? ports.wireId(normalizedNext.onChainHash)
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
  const transition: ContextGraphSubscriptionWriteTransition = {
    contextGraphId, source: previous, subscription: canonicalNext, adoptedWire, options: options ?? {},
  };
  const currentWire = ports.wirePredecessor(contextGraphId);
  if (ports.subscriptions.get(contextGraphId) !== previous
    || currentWire?.localId !== wireOnlySubscription?.localId
    || currentWire?.subscription !== wireOnlySubscription?.subscription)
    throw new Error('Subscription source changed during write');
  retireContextGraphSubscriptionPredecessors(ports, transition);
  // Ending or replacing admission retires in-flight owners even if an
  // unsubscribe/resubscribe restores identical fields in the same turn.
  if (previous !== undefined && canonicalNext !== previous
    && previous.subscribed === canonicalNext.subscribed
    && (previous.coreHosted === true) === (canonicalNext.coreHosted === true)) {
    continueContextGraphSubscriptionLine(previous, canonicalNext);
  }
  const retainsInactiveBinding = retainsInactiveContextGraphBinding(previous, canonicalNext);
  const bindingFacts = ports.applyBinding(
    contextGraphId,
    previous,
    canonicalNext,
    nextWireId,
  );
  if (
    previousWireId !== nextWireId
    && ports.wireOwners.get(previousWireId) === contextGraphId
  ) {
    ports.wireOwners.delete(previousWireId);
  }
  ports.subscriptions.set(contextGraphId, canonicalNext);
  const wireOwnerId = ports.wireOwners.get(nextWireId);
  const wireOwner = wireOwnerId === undefined ? undefined : ports.subscriptions.get(wireOwnerId);
  const preserveWireOwner = options?.deferWireAdoption === true || (
    (options?.preserveAdmittedWireBinding === true || retainsInactiveBinding)
    && wireOwnerId !== contextGraphId
    && (wireOwner?.subscribed === true || wireOwner?.coreHosted === true)
    && (retainsInactiveBinding || wireOwner.onChainId !== canonicalNext.onChainId)
  );
  if (!preserveWireOwner) ports.wireOwners.set(nextWireId, contextGraphId);
  if (
    (canonicalNext.subscribed === true || canonicalNext.coreHosted === true)
    && previous?.subscribed !== true
    && previous?.coreHosted !== true
  ) {
    // A graph known only by its on-chain name hash needs its cleartext id
    // before anything can sync; a no-op for every other row.
    ports.requestNameResolution(contextGraphId);
  }
  updateContextGraphSubscriptionActivationSlot(ports, transition);
  updateContextGraphSubscriptionReceiverEffects(ports, transition, bindingFacts);
  persistContextGraphSubscriptionTransition(ports, transition, retainsInactiveBinding);
  return { subscription: canonicalNext, adoptedWire };
}

function retireContextGraphSubscriptionPredecessors(ports: SubscriptionWritePorts, transition: ContextGraphSubscriptionWriteTransition): void {
  const { contextGraphId, adoptedWire, options } = transition;
  ports.invalidateLists();
  if (options?.retireNamePlaceholder === true) ports.retireNamePlaceholder(contextGraphId);
  if (adoptedWire) {
    // Retire the authenticated placeholder before publishing its canonical
    // row so no RFC-64 responsibility, binding or receiver stays wire-keyed.
    ports.deleteSubscription(adoptedWire.id);
    if (ports.wireOwners.get(adoptedWire.id) === adoptedWire.id) {
      ports.wireOwners.delete(adoptedWire.id);
    }
    ports.info('system',
      `Promoted wire-only Context Graph ${adoptedWire.id.slice(0, 18)}… to local identity "${contextGraphId}"`,
    );
  }
}

function updateContextGraphSubscriptionActivationSlot(ports: SubscriptionWritePorts, transition: ContextGraphSubscriptionWriteTransition): void {
  const { contextGraphId, subscription: canonicalNext, options } = transition;
  const status = ports.rehydrationStatus();
  const rehydratedUserSubscription =
    status?.rehydrationEnabled === true
    && status.activationCap > 0
    && ports.accountedIds.has(contextGraphId)
    && canonicalNext.coreHosted !== true
    && canonicalNext.subscribed === true;
  if (rehydratedUserSubscription) {
    if (rehydratedSubscriptionReachedSafeState(canonicalNext)) {
      if (ports.releaseSlot(contextGraphId, 'readiness')) {
        ports.info('init',
          `Rehydrated context-graph subscription "${contextGraphId}" reached a safe state; rolling activation slot released`,
        );
      }
    } else {
      // Readiness can regress after a later metadata/bootstrap reset. Keep
      // the rolling slot occupied until that new recovery cycle is safe.
      ports.slots.add(contextGraphId);
    }
  } else {
    // An unsubscribe/deactivation also frees a slot, even though it does not
    // satisfy the normal synced readiness signal. Rolling rollback alone
    // leaves its failed candidate to the owner's failure timer.
    ports.releaseSlot(contextGraphId, options?.rollbackSlotRelease ?? 'deactivation');
  }
}

function updateContextGraphSubscriptionReceiverEffects(ports: SubscriptionWritePorts, transition: ContextGraphSubscriptionWriteTransition, bindingFacts: ContextGraphBindingSubscriptionFacts): void {
  const { contextGraphId, source: previous, subscription: canonicalNext } = transition;
  if (ports.receiverSelected(contextGraphId) && ports.isEdge()) {
    // A compatibility manifest is authority material only; the ordinary
    // subscription still owns receiver activity. Preserve its immediate
    // bootstrap invalidation while release-native metadata is still being
    // acquired and the dynamic responsibility registry remains fail-closed.
    ports.receiverSelectionChanged(
      contextGraphId,
      {
        kind: 'subscription',
        previousSubscribed: previous?.subscribed === true,
        nextSubscribed: canonicalNext.subscribed === true,
      },
    );
  }
  if (
    previous === undefined
    || previous.subscribed !== canonicalNext.subscribed
    || previous.coreHosted !== canonicalNext.coreHosted
    || previous.onChainId !== canonicalNext.onChainId
    || previous.metaSynced !== canonicalNext.metaSynced
  ) {
    ports.reconcileResponsibility(contextGraphId);
  }
  // VM cleanup policy belongs to the lifecycle consumer, not to the binding
  // registry. Invalidating a reverse candidate must also invalidate any work
  // captured against it; otherwise only an inactive subscription needs the
  // ordinary cursor cleanup.
  if (bindingFacts.reverseCandidateCleared) {
    ports.forceClearVmState(contextGraphId);
  } else if (!bindingFacts.admitted) {
    ports.clearVmState(contextGraphId);
  }
}

function persistContextGraphSubscriptionTransition(ports: SubscriptionWritePorts, transition: ContextGraphSubscriptionWriteTransition, retainsInactiveBinding: boolean): void {
  const { contextGraphId, source: previous, subscription: canonicalNext, adoptedWire, options } = transition;
  const persistence = projectContextGraphSubscriptionPersistence({
    contextGraphId,
    subscription: canonicalNext,
    syncScoped: ports.syncScoped(contextGraphId),
    preserveInactiveIntent: options?.persist !== true && retainsInactiveBinding
      && previous?.subscribed !== true && previous?.coreHosted !== true,
  });
  if (options?.persist !== false && persistence.action !== 'skip') {
    if (ports.hasStore()) {
      const revision = ports.nextPersistRevision(contextGraphId);
      ports.persist(
        contextGraphId,
        {
          revision,
          preserveDormantHosting: previous?.coreHosted !== true || canonicalNext.coreHosted === true,
          retiredNamePredecessor: adoptedWire,
          updateRehydrationStatus: options?.updateRehydrationStatus !== false,
        },
      );
    }
    if (persistence.persistMemberIntent && canonicalNext.subscribed) {
      ports.persistMembership(contextGraphId);
    } else if (persistence.persistMemberIntent) {
      ports.removeMembership(contextGraphId);
    }
  }
}

