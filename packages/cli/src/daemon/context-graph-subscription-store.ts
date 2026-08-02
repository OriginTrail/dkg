import type { ContextGraphSubscriptionRecord } from '@origintrail-official/dkg-agent';
import {
  type ContextGraphSubscriptionRow,
  type DashboardDB,
} from '@origintrail-official/dkg-node-ui';

/** Map the daemon SQLite row into the agent persistence contract. */
export function contextGraphSubscriptionRecordFromRow(
  row: ContextGraphSubscriptionRow,
): ContextGraphSubscriptionRecord {
  return {
    id: row.context_graph_id,
    name: row.name ?? undefined,
    subscribed: row.subscribed === 1,
    synced: row.synced === 1,
    sharedMemorySynced: row.shared_memory_synced == null ? undefined : row.shared_memory_synced === 1,
    metaSynced: row.meta_synced == null ? undefined : row.meta_synced === 1,
    onChainId: row.on_chain_id ?? undefined,
    onChainHash: row.on_chain_hash ?? undefined,
    lastReconciledOrdinal: row.last_reconciled_ordinal ?? undefined,
    coreHosted: row.core_hosted == null ? undefined : row.core_hosted === 1,
    syncScoped: row.sync_scoped === 1,
    syncAdmission: row.sync_admission ?? undefined,
  };
}

/** Map the agent persistence contract into the daemon SQLite boundary. */
export function contextGraphSubscriptionRecordToRow(
  record: ContextGraphSubscriptionRecord,
  updatedAt = Date.now(),
): Parameters<DashboardDB['upsertContextGraphSubscription']>[0] {
  return {
    context_graph_id: record.id,
    name: record.name ?? null,
    subscribed: record.subscribed ? 1 : 0,
    synced: record.synced ? 1 : 0,
    shared_memory_synced: record.sharedMemorySynced == null ? null : record.sharedMemorySynced ? 1 : 0,
    meta_synced: record.metaSynced == null ? null : record.metaSynced ? 1 : 0,
    on_chain_id: record.onChainId ?? null,
    on_chain_hash: record.onChainHash ?? null,
    last_reconciled_ordinal: record.lastReconciledOrdinal ?? null,
    core_hosted: record.coreHosted == null ? null : record.coreHosted ? 1 : 0,
    sync_scoped: record.syncScoped ? 1 : 0,
    sync_admission: record.syncAdmission ?? null,
    updated_at: updatedAt,
  };
}
