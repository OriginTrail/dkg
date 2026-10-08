import type {
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSubscriptionRecord,
  ContextGraphSyncMode,
} from './dkg-agent-types.js';

export function normalizeContextGraphSubscriptionTransition(
  previous: ContextGraphSub | undefined,
  next: ContextGraphSubInput,
): ContextGraphSub {
  return {
    ...next,
    syncMode: next.syncMode ?? previous?.syncMode ?? 'always-on',
  };
}

/**
 * Inactive readiness retains numeric identity and may enrich a missing hash.
 * Deliberate rebind/unbind or a changed known hash retains ordinary cleanup.
 */
export function retainsInactiveContextGraphBinding(
  previous: ContextGraphSub | undefined,
  next: ContextGraphSub,
): boolean {
  return previous?.subscribed !== true
    && previous?.coreHosted !== true
    && next.subscribed !== true
    && next.coreHosted !== true
    && (previous === undefined || (
      previous.onChainId === next.onChainId
      && (previous.onChainHash === undefined || previous.onChainHash === next.onChainHash)
    ));
}

export function resolveContextGraphSyncMode(input: {
  existing?: Pick<ContextGraphSub, 'subscribed' | 'syncMode'>;
  requested?: ContextGraphSyncMode;
  hasDormantDurableIntent: boolean;
}): ContextGraphSyncMode {
  if (
    input.hasDormantDurableIntent
    || (input.existing?.subscribed === true && input.existing.syncMode === 'always-on')
  ) {
    return 'always-on';
  }
  return input.requested ?? input.existing?.syncMode ?? 'always-on';
}

export type ContextGraphSubscriptionPersistenceProjection =
  | { action: 'skip'; persistMemberIntent: false }
  | { action: 'delete'; persistMemberIntent: true }
  | {
    action: 'save';
    persistMemberIntent: boolean;
    record: ContextGraphSubscriptionRecord;
  };

/**
 * Canonical durable projection for live Context Graph subscription state.
 *
 * On-demand member intent remains process-local. A Core hosting obligation is
 * independently durable and therefore projects to a host-only row. Always-on
 * member intent projects the complete live readiness state.
 */
export function projectContextGraphSubscriptionPersistence(input: {
  contextGraphId: string;
  subscription: ContextGraphSub | undefined;
  syncScoped: boolean;
  /** Readiness/enrichment owns no removal of saved inactive member intent. */
  preserveInactiveIntent?: boolean;
}): ContextGraphSubscriptionPersistenceProjection {
  const sub = input.subscription;
  if (sub?.syncMode === 'on-demand' && sub.coreHosted !== true) {
    return { action: 'skip', persistMemberIntent: false };
  }
  if (!sub?.subscribed && !sub?.coreHosted) {
    return input.preserveInactiveIntent === true
      ? { action: 'skip', persistMemberIntent: false }
      : { action: 'delete', persistMemberIntent: true };
  }

  const persistMemberIntent = sub.syncMode !== 'on-demand';
  return {
    action: 'save',
    persistMemberIntent,
    record: {
      id: input.contextGraphId,
      name: sub.name,
      subscribed: persistMemberIntent && sub.subscribed,
      synced: persistMemberIntent && sub.synced,
      sharedMemorySynced: persistMemberIntent ? sub.sharedMemorySynced : false,
      metaSynced: persistMemberIntent ? sub.metaSynced : false,
      onChainId: sub.onChainId,
      onChainHash: sub.onChainHash,
      lastReconciledOrdinal: sub.lastReconciledOrdinal,
      coreHosted: sub.coreHosted,
      syncScoped: persistMemberIntent && input.syncScoped,
    },
  };
}
