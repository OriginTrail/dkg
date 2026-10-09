import type {
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  ContextGraphSyncMode,
} from './dkg-agent-types.js';
import { projectDormantContextGraphIdentities } from './context-graph-dormant-identity.js';

/** Retained identity alone grants neither member admission nor Core custody. */
export function isAdmittedContextGraphSubscription(
  subscription: Pick<ContextGraphSub, 'subscribed' | 'coreHosted'> | undefined,
): boolean {
  return subscription?.subscribed === true || subscription?.coreHosted === true;
}

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
 * An inactive next state retains identity, including explicit unsubscribe.
 * A missing hash may be enriched; numeric/known-hash changes do not retain it.
 */
export function retainsInactiveContextGraphBinding(
  previous: ContextGraphSub | undefined,
  next: ContextGraphSub,
): boolean {
  return next.subscribed !== true
    && next.coreHosted !== true
    && (previous === undefined || (
      previous.onChainId === next.onChainId
      && (previous.onChainHash === undefined || previous.onChainHash === next.onChainHash)
    ));
}

/** Identity-only writes cannot retire already admitted wire custody. */
export function mayAdoptContextGraphWireSubscription(
  next: ContextGraphSubInput,
  wire: ContextGraphSub,
): boolean {
  return next.subscribed === true || next.coreHosted === true
    || (wire.subscribed !== true && wire.coreHosted !== true);
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

/** Preserve non-coalescing queued intent without lending it a different binding. */
export function isContextGraphSubscriptionPersistenceTargetCurrent(
  captured: ContextGraphSub | undefined,
  input: { subscription: ContextGraphSub | undefined; syncScoped: boolean },
  current: ContextGraphSub | undefined,
  state: {
    revision: number | undefined;
    pendingRevisions: ReadonlySet<number> | undefined;
    syncScoped: boolean;
  },
): boolean {
  const snapshot = input.subscription;
  if (snapshot?.onChainId !== current?.onChainId
    || snapshot?.onChainHash !== current?.onChainHash) return false;
  // A genuine queued successor owns the later durable intent. Both snapshots
  // execute in order; a failed successor must not erase the older success.
  const revision = state.revision;
  if (current !== undefined && revision !== undefined
    && [...(state.pendingRevisions ?? [])].some((pending) => pending > revision)) return true;
  if (current === captured) return true;
  if (!snapshot || !current || state.syncScoped !== input.syncScoped
    || isAdmittedContextGraphSubscription(snapshot)
    || isAdmittedContextGraphSubscription(current)) return false;
  // Inactive discovery owns name/participant enrichment, not a replacement
  // durable write. Every other persisted field must retain its captured value.
  return snapshot.syncMode === current.syncMode
    && snapshot.subscribed === current.subscribed && snapshot.coreHosted === current.coreHosted
    && snapshot.synced === current.synced && snapshot.sharedMemorySynced === current.sharedMemorySynced
    && snapshot.metaSynced === current.metaSynced
    && snapshot.lastReconciledOrdinal === current.lastReconciledOrdinal;
}

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

/** Join approval owns this exact durable snapshot, including sync scope. */
export function projectContextGraphJoinSubscriptionRecord(
  contextGraphId: string,
  subscription: ContextGraphSub,
): ContextGraphSubscriptionRecord {
  return {
    id: contextGraphId,
    name: subscription.name,
    subscribed: subscription.subscribed,
    synced: subscription.synced,
    sharedMemorySynced: subscription.sharedMemorySynced,
    metaSynced: subscription.metaSynced,
    onChainId: subscription.onChainId,
    onChainHash: subscription.onChainHash,
    lastReconciledOrdinal: subscription.lastReconciledOrdinal,
    coreHosted: subscription.coreHosted,
    syncScoped: true,
  };
}

/** Only the independent hosting bit crosses a matching durable identity. */
export function preserveSavedContextGraphCoreHosting(
  record: ContextGraphSubscriptionRecord,
  previous: ContextGraphSubscriptionRecord | null,
): ContextGraphSubscriptionRecord {
  if (record.coreHosted === true || previous?.coreHosted !== true) return record;
  const current = projectDormantContextGraphIdentities([record]).get(record.id);
  const saved = projectDormantContextGraphIdentities([previous]).get(previous.id);
  if (
    current === undefined || saved === undefined
    || current.onChainId !== saved.onChainId || current.onChainHash !== saved.onChainHash
    || (previous.id !== record.id && previous.id.toLowerCase() !== current.onChainHash)
  ) return record;
  return { ...record, coreHosted: true };
}

/** Must run inside the caller's existing serialized store-write lane. */
export async function readPreservedContextGraphCoreHosting(
  store: ContextGraphSubscriptionStore,
  record: ContextGraphSubscriptionRecord,
  previous?: ContextGraphSubscriptionRecord | null,
): Promise<ContextGraphSubscriptionRecord> {
  if (record.coreHosted === true) return record;
  const identity = projectDormantContextGraphIdentities([record]).get(record.id);
  if (identity?.onChainHash === undefined) return record;
  const nameHash = identity.onChainHash;
  let rows: ContextGraphSubscriptionRecord[] | undefined;
  if (previous === undefined) {
    if (store.load) previous = await store.load(record.id);
    else {
      rows = await store.loadAll();
      const matches = rows.filter((row) => row.id === record.id);
      previous = matches.length === 1 ? matches[0] : null;
    }
  }
  const saved = preserveSavedContextGraphCoreHosting(record, previous);
  if (saved.coreHosted === true || nameHash === record.id.toLowerCase()) return saved;
  rows ??= await store.loadAll();
  const wireRows = rows.filter((row) => typeof row?.id === 'string' && row.id.toLowerCase() === nameHash);
  // Alias cleanup groups every case variant. None may assert a foreign slot
  // or a malformed/literal-hash commitment before hosting is transferred.
  if (wireRows.some((row) => {
    const wire = projectDormantContextGraphIdentities([row]).get(row.id);
    return wire === undefined || wire.onChainId !== identity.onChainId || wire.onChainHash !== nameHash;
  })) return saved;
  return wireRows.reduce(preserveSavedContextGraphCoreHosting, saved);
}

export async function projectContextGraphSubscriptionPersistenceWithSavedHosting(
  input: Parameters<typeof projectContextGraphSubscriptionPersistence>[0],
  store: ContextGraphSubscriptionStore,
  preserveDormantHosting = true,
): Promise<ContextGraphSubscriptionPersistenceProjection> {
  const projection = projectContextGraphSubscriptionPersistence(input);
  if (!preserveDormantHosting || !input.subscription || projection.action === 'skip') return projection;
  const hosted = projectContextGraphSubscriptionPersistence({
    ...input, subscription: { ...input.subscription, coreHosted: true },
  });
  if (hosted.action !== 'save') return projection;
  const record = await readPreservedContextGraphCoreHosting(store, {
    ...hosted.record, coreHosted: input.subscription.coreHosted,
  });
  return record.coreHosted === true ? { ...hosted, record } : projection;
}
