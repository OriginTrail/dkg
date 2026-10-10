// SPDX-License-Identifier: Apache-2.0
// Shared by the Hardhat fence suite and the hermetic request-lane suite.
import { vi } from 'vitest';
import { RollingSubscriptionChecks } from '../../src/context-graph-subscription-rolling-checks.js';
import type { RollingSubscriptionPromotionPorts } from '../../src/context-graph-subscription-authority-recovery.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from '../../src/dkg-agent-types.js';
import type { ContextGraphDormancyReason } from '../../src/context-graph-subscription-dormancy.js';
import type { CoalescingRecurringTask } from '../../src/coalescing-recurring-task.js';

export type SavedPromotionRow = Partial<ContextGraphSubscriptionRecord> & { id: string };
export type PromotionAuthorityRead = Parameters<RollingSubscriptionPromotionPorts['resolveContextGraphSubscriptionBootstrapAuthority']>[1];

export function savedPromotionRow(row: SavedPromotionRow): ContextGraphSubscriptionRecord {
  return { subscribed: false, synced: false, syncScoped: false, ...row };
}

export function promotionSubscription(row: Partial<ContextGraphSub> = {}): ContextGraphSub {
  return { syncMode: 'always-on', subscribed: false, synced: false, ...row };
}

export function createRollingPromotionFixture(
  rows: readonly SavedPromotionRow[],
  options: {
    cap?: number;
    checks?: RollingSubscriptionChecks;
    authority?: 'allowed' | 'denied' | 'unavailable';
    answer?: RollingSubscriptionPromotionPorts['resolveContextGraphSubscriptionBootstrapAuthority'];
    load?: (id: string) => Promise<SavedPromotionRow | null>;
    activate?: RollingSubscriptionPromotionPorts['activatePersistedContextGraphSubscriptionRecord'];
  } = {},
) {
  const savedRows = new Map(rows.map(row => [row.id, savedPromotionRow(row)]));
  const load = vi.fn(async (id: string) => {
    const row = options.load ? await options.load(id) : savedRows.get(id);
    return row ? savedPromotionRow(row) : null;
  });
  const runtime: Pick<CoalescingRecurringTask, 'owns' | 'request' | 'whenIdle'> = {
    owns: () => true, request: vi.fn(() => true), whenIdle: async () => undefined,
  };
  const host = {
    savedRows,
    config: { contextGraphSubscriptionStore: { load, loadAll: async () => [...savedRows.values()] } },
    contextGraphSubscriptionRehydrationStatus: { rehydrationEnabled: true, activationCap: options.cap ?? 64 },
    contextGraphSubscriptionRehydrationPromotionRuntime: runtime,
    contextGraphSubscriptionAuthorityRecoveryRuntime: undefined,
    contextGraphSubscriptionRollingChecks: options.checks ?? new RollingSubscriptionChecks({ minPauseMs: 0, pausePerCheckTime: 0 }),
    contextGraphSubscriptionRehydrationPendingIds: new Set(rows.map(row => row.id)),
    contextGraphSubscriptionRehydrationSlotIds: new Set<string>(),
    contextGraphSubscriptionDormancyById: new Map<string, ContextGraphDormancyReason>(rows.map(row => [row.id, 'activationCap'])),
    contextGraphSubscriptionPersistRevisions: new Map<string, number>(),
    subscribedContextGraphs: new Map<string, ContextGraphSub>(),
    started: true,
    log: { warn: vi.fn<RollingSubscriptionPromotionPorts['log']['warn']>(), info: vi.fn<RollingSubscriptionPromotionPorts['log']['info']>(), debug: vi.fn<RollingSubscriptionPromotionPorts['log']['debug']>() },
    touchStatus: vi.fn(),
    updateContextGraphSubscriptionRehydrationStatusAfterClear: vi.fn<RollingSubscriptionPromotionPorts['updateContextGraphSubscriptionRehydrationStatusAfterClear']>(),
    updateContextGraphSubscriptionRehydrationStatusAfterPersist: vi.fn<RollingSubscriptionPromotionPorts['updateContextGraphSubscriptionRehydrationStatusAfterPersist']>(),
    persistContextGraphSubscriptionStrict: vi.fn<RollingSubscriptionPromotionPorts['persistContextGraphSubscriptionStrict']>(async () => undefined),
    reconcileRfc64CatalogResponsibilityV1: vi.fn<RollingSubscriptionPromotionPorts['reconcileRfc64CatalogResponsibilityV1']>(async () => undefined),
    resolveContextGraphSubscriptionBootstrapAuthority: vi.fn<RollingSubscriptionPromotionPorts['resolveContextGraphSubscriptionBootstrapAuthority']>(options.answer ?? (async () => options.authority === 'unavailable'
      ? { outcome: 'unavailable', source: 'legacy-local', reason: 'test', metadataBootstrap: 'eligible', dependency: 'unknown' }
      : { outcome: options.authority ?? 'allowed', source: 'legacy-local', reason: 'test', metadataBootstrap: 'eligible' })),
    activatePersistedContextGraphSubscriptionRecord: vi.fn<RollingSubscriptionPromotionPorts['activatePersistedContextGraphSubscriptionRecord']>(options.activate ?? (async row => {
      host.subscribedContextGraphs.set(row.id, promotionSubscription({ subscribed: row.subscribed, coreHosted: row.coreHosted, metaSynced: false, pendingMeta: false }));
    })),
  } satisfies RollingSubscriptionPromotionPorts & { savedRows: Map<string, ContextGraphSubscriptionRecord> };
  return { agent: host, load };
}

export type RollingPromotionFixture = ReturnType<typeof createRollingPromotionFixture>['agent'];
