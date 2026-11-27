import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { PersistedSubscriptionNameBindingRetry } from '../src/context-graph-subscription-name-binding-retry.js';
import { unavailableContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import type { ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

let agent: DKGAgent | undefined;
afterEach(async () => { vi.restoreAllMocks(); await agent?.stop(); agent = undefined; });

describe('name-binding retry retirement during real activation preparation', () => {
  it.each(['window', 'shutdown'] as const)('rolls back when %s retires the owner', async retirement => {
    const row: ContextGraphSubscriptionRecord = { id: 'retiring-recovery', subscribed: true,
      synced: true, sharedMemorySynced: true, metaSynced: true, syncScoped: true };
    const save = vi.fn(async () => {});
    agent = await DKGAgent.create({ name: 'RecoveryRetirement', chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false }, maxRehydratedContextGraphSubscriptions: 1,
      contextGraphSubscriptionStore: { loadAll: async () => [{ ...row }], load: async () => ({ ...row }),
        save, delete: async () => {} } });
    const authority = vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
    authority.mockResolvedValue(unavailableContextGraphReadAuthorityDecision('registered-chain', 'chain-name-binding-unavailable'));
    await agent.rehydrateContextGraphSubscriptions(null);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ activated: 0 });
    authority.mockResolvedValue({ outcome: 'allowed', source: 'registered-chain', reason: 'open-context-graph',
      grantScope: 'public', metadataBootstrap: 'forbidden', onChainId: 1n });
    const wire = vi.spyOn(agent, 'installContextGraphSubscription');
    const events = vi.fn(); agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, events);
    let release!: () => void, began!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { began = resolve; });
    const reconcile = vi.spyOn(agent, 'reconcileRfc64CatalogResponsibilityV1').mockImplementation(async () => { began(); await held; });
    const controller = new AbortController(); let now = 0;
    const ports = agent.subscriptionRecoveryRowPorts(() => !controller.signal.aborted)!;
    const retry = new PersistedSubscriptionNameBindingRetry({ ...ports, signal: controller.signal,
      track: () => {}, log: { info: () => {}, warn: () => {} } }, { windowMs: 100, checkTimeoutMs: 1000, now: () => now });
    retry.take([row.id]);
    await preparing;
    expect(agent.getSubscribedContextGraphs().get(row.id)?.subscribed).toBe(true);
    if (retirement === 'window') now = 101; else controller.abort();
    release(); await retry.whenIdle();
    expect(agent.getSubscribedContextGraphs().get(row.id)?.subscribed ?? false).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ activated: 0,
      dormantReasons: { authorityUnavailable: [row.id] } });
    expect(wire).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    // A subsequent real activation reaches preparation: the cancelled reservation was released.
    reconcile.mockRejectedValueOnce(new Error('next preparation reached'));
    await expect(agent.activateUnavailablePersistedContextGraphSubscription(row, '1', () => true))
      .rejects.toThrow('next preparation reached');
  });
});
