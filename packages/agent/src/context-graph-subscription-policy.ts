import type {
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSyncAdmission,
  ContextGraphSubscriptionRecord,
  ContextGraphSyncMode,
  NormalizedContextGraphSub,
} from './dkg-agent-types.js';

export function normalizeLegacyContextGraphSubscriptionInput(
  previous: ContextGraphSub | undefined,
  next: ContextGraphSubInput,
  defaultAdmission: ContextGraphSyncAdmission = 'none',
): NormalizedContextGraphSub {
  return {
    ...next,
    syncMode: next.syncMode ?? previous?.syncMode ?? 'always-on',
    syncAdmission: next.syncAdmission ?? previous?.syncAdmission ?? defaultAdmission,
  };
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
  subscription: NormalizedContextGraphSub | undefined;
  /** Durable baseline retained when current config overlays a different live admission. */
  durableSyncAdmission?: ContextGraphSyncAdmission;
  /** Optional legacy-call override; current callers persist the live admission. */
  syncScoped?: boolean;
}): ContextGraphSubscriptionPersistenceProjection {
  const sub = input.subscription;
  if (sub?.syncMode === 'on-demand' && sub.coreHosted !== true) {
    return { action: 'skip', persistMemberIntent: false };
  }
  if (!sub?.subscribed && !sub?.coreHosted) {
    return { action: 'delete', persistMemberIntent: true };
  }

  const persistMemberIntent = sub.syncMode !== 'on-demand';
  const syncAdmission = persistMemberIntent
    ? input.durableSyncAdmission
      ?? (input.syncScoped === undefined
        ? sub.syncAdmission
        : input.syncScoped ? 'explicit' : 'none')
    : 'none';
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
      syncAdmission,
      // Keep the legacy compatibility bit derived from the canonical lane.
      syncScoped: syncAdmission === 'explicit',
    },
  };
}
