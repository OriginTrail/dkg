import { createTestSubscriptionActivations } from './_helpers/subscription-activation-owner.js';
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { ContextGraphSubscriptionActivations } from '../src/context-graph-subscription-activation-state.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

function fixture() {
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.assign(agent, {
    contextGraphSubscriptionDormancyById: new Map(),
    contextGraphSubscriptionRehydrationAccountedIds: new Set(),
    contextGraphSubscriptionRehydrationPendingIds: new Set(),
    contextGraphSubscriptionRehydrationSlotIds: new Set(),
    contextGraphSubscriptionRehydrationStatus: { persistedTotal: 0, activated: 0,
      hostedActivated: 0, hostedActivatedIds: [], rehydrationEnabled: true, activationCap: 1 },
    subscribedContextGraphs: new Map(),
    clearContextGraphSubscriptionPersistRevisionStateIfIdle: vi.fn(),
    eventBus: { emit: vi.fn() },
  });
  agent.contextGraphSubscriptionActivations = createTestSubscriptionActivations(agent);
  return agent;
}
const intent = (id: string): ContextGraphSubscriptionRecord => ({ id, subscribed: true, synced: false, syncScoped: true });
const subscription = (hosted = false): ContextGraphSub => ({ syncMode: 'always-on', subscribed: true, synced: false, coreHosted: hosted });

it('accounts persistence and activation from captured transitions after dormancy changes, before notification', async () => {
  const agent = fixture(), id = 'queued';
  const owner: ContextGraphSubscriptionActivations = agent.contextGraphSubscriptionActivations;
  agent.subscribedContextGraphs.set(id, { ...subscription(), subscribed: false });
  owner.reset([intent(id)]);
  agent.recordContextGraphSubscriptionPersistence(id, intent(id));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 1, activated: 0, dormant: 1 });
  agent.contextGraphSubscriptionRehydrationPendingIds.add(id);
  const live = subscription();
  const wait = owner.wait(id, new AbortController().signal);
  let status = agent.contextGraphSubscriptionRehydrationStatus;
  const observations: unknown[] = [], accountingWaits: Promise<unknown>[] = [];
  Object.defineProperty(agent, 'contextGraphSubscriptionRehydrationStatus', {
    get: () => status,
    set: next => {
      accountingWaits.push(owner.wait(id, new AbortController().signal).catch(error => error.message));
      observations.push({ dormancy: agent.contextGraphSubscriptionDormancyById.get(id),
        pending: agent.contextGraphSubscriptionRehydrationPendingIds.has(id),
        slot: agent.contextGraphSubscriptionRehydrationSlotIds.has(id) });
      status = next;
    },
  });
  const atEvent: unknown[] = [];
  agent.eventBus.emit.mockImplementation(() => atEvent.push({ status: agent.getContextGraphSubscriptionRehydrationStatus(),
    slot: agent.contextGraphSubscriptionRehydrationSlotIds.has(id) }));
  await owner.activate(intent(id), {
    install: () => { agent.subscribedContextGraphs.set(id, live); return live; },
    remove: key => { agent.subscribedContextGraphs.delete(key); },
    rollbackNetworkEffects() {}, trackSync() {}, subscribe() {}, persistMembership() {},
    commit: () => live,
  });
  expect(observations).toEqual([{ dormancy: undefined, pending: false, slot: true }]);
  expect(atEvent).toEqual([{ status: expect.objectContaining({ persistedTotal: 1, activated: 1, dormant: 0 }), slot: true }]);
  await expect(wait).resolves.toEqual({ kind: 'committed', subscription: live });
  expect(await Promise.all(accountingWaits)).toEqual([{ kind: 'committed', subscription: live }]);
  await expect(owner.wait(id, new AbortController().signal)).rejects.toThrow('ownership changed');
  agent.recordContextGraphSubscriptionPersistence(id, intent(id));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 1, activated: 1 });
  expect(agent.eventBus.emit).toHaveBeenCalledTimes(1);
});

it('accounts mixed active and dormant clear/deactivation as one batch before cancelling owners', async () => {
  const agent = fixture(), ids = ['active-clear', 'dormant-clear', 'active-deactivate', 'dormant-deactivate'];
  const owner: ContextGraphSubscriptionActivations = agent.contextGraphSubscriptionActivations;
  owner.reset(ids.map(intent));
  for (const id of ids) {
    agent.contextGraphSubscriptionRehydrationAccountedIds.add(id);
    agent.contextGraphSubscriptionRehydrationPendingIds.add(id);
    agent.contextGraphSubscriptionRehydrationSlotIds.add(id);
    if (id.startsWith('dormant')) agent.contextGraphSubscriptionDormancyById.set(id, 'activationCap');
  }
  Object.assign(agent.contextGraphSubscriptionRehydrationStatus, { persistedTotal: 4, activated: 2,
    hostedActivated: 1, hostedActivatedIds: ['active-deactivate'] });
  const waits = ids.map(id => owner.wait(id, new AbortController().signal));
  let status = agent.contextGraphSubscriptionRehydrationStatus;
  const observations: unknown[] = [], accountingWaits: Promise<unknown>[] = [];
  Object.defineProperty(agent, 'contextGraphSubscriptionRehydrationStatus', {
    get: () => status,
    set: next => {
      accountingWaits.push(...ids.map(id => owner.wait(id, new AbortController().signal).catch(error => error.message)));
      observations.push({ status: next, dormancy: [...agent.contextGraphSubscriptionDormancyById],
        pending: [...agent.contextGraphSubscriptionRehydrationPendingIds],
        slots: [...agent.contextGraphSubscriptionRehydrationSlotIds] });
      status = next;
    },
  });
  agent.recordContextGraphSubscriptionClear(ids.slice(0, 2), ids.slice(2));
  expect(observations).toEqual([{ status: expect.objectContaining({ persistedTotal: 2, activated: 0, hostedActivated: 0 }),
    dormancy: expect.arrayContaining([[ids[2], 'deactivated'], [ids[3], 'deactivated']]),
    pending: [], slots: [] }]);
  expect(await Promise.all(accountingWaits)).toEqual(ids.map(() => ({ kind: 'cancelled' })));
  expect(agent.clearContextGraphSubscriptionPersistRevisionStateIfIdle.mock.calls).toEqual([[ids[0]], [ids[1]]]);
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 2, activated: 0, hostedActivated: 0, dormant: 2 });
  expect([...agent.contextGraphSubscriptionRehydrationPendingIds]).toEqual([]);
  expect([...agent.contextGraphSubscriptionRehydrationSlotIds]).toEqual([]);
  expect(await Promise.all(waits)).toEqual(ids.map(() => ({ kind: 'cancelled' })));
  agent.recordContextGraphSubscriptionClear(ids.slice(0, 2), ids.slice(2));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 2, activated: 0 });
});

it('uses one accounting owner for startup commits, durable clears and later retries while publishing only completed startup status', async () => {
  const agent = fixture();
  agent.contextGraphSubscriptionRehydrationStatus = null;
  const owner: ContextGraphSubscriptionActivations = agent.contextGraphSubscriptionActivations;
  const rows = ['hosted', 'retry', 'cleared'].map(intent);
  owner.reset(rows);
  owner.beginRehydration(rows, { rehydrationEnabled: true, systemExcluded: 2, activationCap: 1 });
  const activate = async (id: string, hosted: boolean) => {
    const live = subscription(hosted);
    await owner.activate(intent(id), {
      install: () => { agent.subscribedContextGraphs.set(id, live); return live; },
      remove: key => { agent.subscribedContextGraphs.delete(key); },
      rollbackNetworkEffects() {}, trackSync() {}, subscribe() {}, persistMembership() {}, commit: () => live,
    });
  };
  await activate('hosted', true);
  owner.transition({ id: 'cleared', kind: 'cleared' });
  // Startup completion, not an activation event, exposes the report.
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toBeNull();
  expect(agent.eventBus.emit).toHaveBeenCalledTimes(1);
  const startup = owner.completeRehydration();
  expect(startup).toMatchObject({ persistedTotal: 2, activated: 1, hostedActivated: 1,
    hostedActivatedIds: ['hosted'], systemExcluded: 2, activationCap: 1 });
  expect([...agent.contextGraphSubscriptionRehydrationAccountedIds].sort()).toEqual(['hosted', 'retry']);
  await activate('retry', false);
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 2, activated: 2,
    hostedActivated: 1, dormant: 0, completedAt: startup.completedAt });
  expect([...agent.contextGraphSubscriptionRehydrationSlotIds]).toEqual(['retry']);
  expect(agent.eventBus.emit).toHaveBeenCalledTimes(2);
});
