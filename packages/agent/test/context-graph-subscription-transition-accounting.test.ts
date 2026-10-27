import { createTestSubscriptionActivations } from './_helpers/subscription-activation-owner.js';
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { ContextGraphSubscriptionActivations } from '../src/context-graph-subscription-activation-state.js';
import type { SubscriptionAccountingChange } from '../src/context-graph-subscription-accounting.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

function fixture() {
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.assign(agent, {
    contextGraphSubscriptionDormancyById: new Map(),
    contextGraphSubscriptionRehydrationAccountedIds: new Set(),
    contextGraphSubscriptionRehydrationPendingIds: new Set(),
    contextGraphSubscriptionRehydrationSlotIds: new Set(),
    contextGraphSubscriptionRehydrationStatus: { persistedTotal: 0, activated: 0,
      hostedActivated: 0, hostedActivatedIds: [], rehydrationEnabled: true },
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
  agent.recordContextGraphSubscriptionPersistence(id, intent(id));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 1, activated: 0, dormant: 1 });
  agent.contextGraphSubscriptionRehydrationPendingIds.add(id);
  const live = subscription(), handle = owner.observe(intent(id));
  owner.install(handle, live); owner.stage(handle, live);
  agent.subscribedContextGraphs.set(id, live);
  const wait = owner.wait(id, new AbortController().signal);
  let status = agent.contextGraphSubscriptionRehydrationStatus;
  const observations: unknown[] = [];
  Object.defineProperty(agent, 'contextGraphSubscriptionRehydrationStatus', {
    get: () => status,
    set: next => {
      observations.push({ dormancy: agent.contextGraphSubscriptionDormancyById.get(id),
        pending: agent.contextGraphSubscriptionRehydrationPendingIds.has(id),
        slot: agent.contextGraphSubscriptionRehydrationSlotIds.has(id), owner: owner.get(id) === handle });
      status = next;
    },
  });
  const atEvent: unknown[] = [];
  agent.eventBus.emit.mockImplementation(() => atEvent.push({ status: agent.getContextGraphSubscriptionRehydrationStatus(),
    slot: agent.contextGraphSubscriptionRehydrationSlotIds.has(id), owner: owner.get(id) }));
  agent.finalizePersistedContextGraphSubscriptionActivation(id, true);
  expect(observations).toEqual([{ dormancy: undefined, pending: false, slot: true, owner: true }]);
  expect(atEvent).toEqual([{ status: expect.objectContaining({ persistedTotal: 1, activated: 1, dormant: 0 }), slot: true, owner: undefined }]);
  await expect(wait).resolves.toEqual({ kind: 'committed', subscription: live });
  agent.finalizePersistedContextGraphSubscriptionActivation(id, true);
  agent.recordContextGraphSubscriptionPersistence(id, intent(id));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 1, activated: 1 });
  expect(agent.eventBus.emit).toHaveBeenCalledTimes(1);
});

it('accounts mixed active and dormant clear/deactivation as one batch before cancelling owners', async () => {
  const agent = fixture(), ids = ['active-clear', 'dormant-clear', 'active-deactivate', 'dormant-deactivate'];
  const owner: ContextGraphSubscriptionActivations = agent.contextGraphSubscriptionActivations;
  for (const id of ids) {
    agent.contextGraphSubscriptionRehydrationAccountedIds.add(id);
    agent.contextGraphSubscriptionRehydrationPendingIds.add(id);
    agent.contextGraphSubscriptionRehydrationSlotIds.add(id);
    if (id.startsWith('dormant')) agent.contextGraphSubscriptionDormancyById.set(id, 'activationCap');
    owner.observe(intent(id));
  }
  Object.assign(agent.contextGraphSubscriptionRehydrationStatus, { persistedTotal: 4, activated: 2,
    hostedActivated: 1, hostedActivatedIds: ['active-deactivate'] });
  const waits = ids.map(id => owner.wait(id, new AbortController().signal));
  const account = agent.accountContextGraphSubscriptionTransitions.bind(agent);
  const observations: unknown[] = [];
  vi.spyOn(agent, 'accountContextGraphSubscriptionTransitions').mockImplementation((input: unknown) => {
    const changes = input as readonly SubscriptionAccountingChange[];
    observations.push({ changes, dormancy: [...agent.contextGraphSubscriptionDormancyById], owners: ids.map(id => !!owner.get(id)) });
    account(changes);
  });
  agent.recordContextGraphSubscriptionClear(ids.slice(0, 2), ids.slice(2));
  expect(observations).toEqual([{ changes: expect.arrayContaining([
    { kind: 'cleared', dormancy: { id: ids[0], before: undefined, after: undefined } },
    { kind: 'cleared', dormancy: { id: ids[1], before: 'activationCap', after: undefined } },
    { kind: 'deactivated', dormancy: { id: ids[2], before: undefined, after: 'deactivated' } },
    { kind: 'deactivated', dormancy: { id: ids[3], before: 'activationCap', after: 'deactivated' } },
  ]), dormancy: expect.arrayContaining([[ids[2], 'deactivated'], [ids[3], 'deactivated']]), owners: [true, true, true, true] }]);
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 2, activated: 0, hostedActivated: 0, dormant: 2 });
  expect([...agent.contextGraphSubscriptionRehydrationPendingIds]).toEqual([]);
  expect([...agent.contextGraphSubscriptionRehydrationSlotIds]).toEqual([]);
  expect(await Promise.all(waits)).toEqual(ids.map(() => ({ kind: 'cancelled' })));
  agent.recordContextGraphSubscriptionClear(ids.slice(0, 2), ids.slice(2));
  expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ persistedTotal: 2, activated: 0 });
});
