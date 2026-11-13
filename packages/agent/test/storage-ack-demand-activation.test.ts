import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_ACK_DEMAND_IDLE_MS,
  STORAGE_ACK_DEMAND_MAX_MS,
  StorageAckDemandActivations,
  type StorageAckDemandActivationPorts,
} from '../src/storage-ack-demand-activation.js';
import type { ContextGraphDormancyReason } from '../src/context-graph-subscription-dormancy.js';
import type { ContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  DurableContextGraphSubscriptionBinding,
} from '../src/dkg-agent-types.js';

/**
 * A StorageACK request that finds a saved row dormant activates that row at
 * once, with the binding the request named, instead of waiting for the paced
 * owners. Every timer is faked: the times below are the node's own.
 */

const ALLOWED = (onChainId: bigint): ContextGraphReadAuthorityDecision => ({
  outcome: 'allowed', grantScope: 'public', source: 'registered-chain',
  reason: 'open-context-graph', metadataBootstrap: 'forbidden', onChainId,
});
const UNAVAILABLE: ContextGraphReadAuthorityDecision = {
  outcome: 'unavailable', source: 'registered-chain', reason: 'chain-access-policy-unavailable',
  metadataBootstrap: 'forbidden', dependency: 'chain',
};
const DENIED: ContextGraphReadAuthorityDecision = {
  outcome: 'denied', grantScope: 'none', source: 'registered-chain',
  reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden',
};

type Answer = ContextGraphReadAuthorityDecision | (() => Promise<ContextGraphReadAuthorityDecision>);

function host(rows: ContextGraphSubscriptionRecord[], options: {
  dormancy?: ContextGraphDormancyReason;
  answers?: Answer[];
  current?: boolean;
} = {}) {
  const saved = new Map(rows.map((row) => [row.id, { ...row }]));
  const dormancy = new Map<string, ContextGraphDormancyReason>(
    rows.map((row) => [row.id, options.dormancy ?? 'activationCap']),
  );
  const revisions = new Map<string, number>();
  const subscriptions = new Map<string, ContextGraphSub>();
  const answers = [...(options.answers ?? [])];
  const controller = new AbortController();
  const checks: Array<{ binding: DurableContextGraphSubscriptionBinding; at: number }> = [];
  const activations: Array<{ id: string; onChainId: string; at: number }> = [];
  const retired: Array<{ id: string; reason: ContextGraphDormancyReason }> = [];
  const info: string[] = [];
  const state = { current: options.current ?? true };
  const ports: StorageAckDemandActivationPorts = {
    signal: controller.signal,
    isCurrent: () => state.current,
    dormancy: (id) => dormancy.get(id),
    revision: (id) => revisions.get(id) ?? 0,
    subscription: (id) => subscriptions.get(id),
    load: async (id) => {
      const row = saved.get(id);
      return row === undefined ? null : { ...row };
    },
    resolveAuthority: async (binding) => {
      checks.push({ binding: { ...binding }, at: Date.now() });
      const next = answers.length > 1 ? answers.shift()! : answers[0] ?? ALLOWED(BigInt(binding.onChainId!));
      return typeof next === 'function' ? next() : next;
    },
    activate: async (row, onChainId, isCurrent) => {
      const subscription: ContextGraphSub = { syncMode: 'always-on', subscribed: row.subscribed, synced: false, onChainId };
      subscriptions.set(row.id, subscription);
      if (!isCurrent(subscription)) {
        subscriptions.delete(row.id);
        throw new Error('stale');
      }
      saved.set(row.id, { ...row, onChainId });
      dormancy.delete(row.id);
      activations.push({ id: row.id, onChainId, at: Date.now() });
    },
    retire: (id, reason) => {
      dormancy.set(id, reason);
      retired.push({ id, reason });
    },
    track: () => undefined,
    log: {
      info: (message) => { info.push(message); },
      warn: () => undefined,
      debug: () => undefined,
    },
  };
  return { ports, saved, dormancy, revisions, subscriptions, checks, activations, retired, info, controller, state };
}

function row(id: string, extra: Partial<ContextGraphSubscriptionRecord> = {}): ContextGraphSubscriptionRecord {
  return { id, subscribed: true, synced: false, syncScoped: true, ...extra };
}

describe('StorageACK demand activation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('activates a row the cap left dormant at once, with the binding the request named', async () => {
    const h = host([row('new-graph')]);
    const demand = new StorageAckDemandActivations(h.ports);
    const startedAt = Date.now();

    expect(demand.request('new-graph', '1001')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await demand.whenIdle();

    expect(h.checks).toHaveLength(1);
    expect(h.checks[0].binding).toEqual({ contextGraphId: 'new-graph', onChainId: '1001' });
    expect(h.activations).toEqual([{ id: 'new-graph', onChainId: '1001', at: startedAt }]);
    expect(h.dormancy.has('new-graph')).toBe(false);
    expect(h.info.join('\n')).toContain('Activated persisted context-graph subscription "new-graph" for StorageACK requests 0 ms after the first (was activationCap; 1 check(s))');
  });

  it('activates a row recovery holds as unavailable, keeping its own binding', async () => {
    const h = host([row('hosted-graph', { coreHosted: true, subscribed: false, onChainId: '1002' })], {
      dormancy: 'authorityUnavailable',
    });
    const demand = new StorageAckDemandActivations(h.ports);

    expect(demand.request('hosted-graph', '1002')).toBe(true);
    await demand.whenIdle();

    expect(h.checks.map((check) => check.binding)).toEqual([{ contextGraphId: 'hosted-graph', onChainId: '1002' }]);
    expect(h.activations.map((activation) => activation.id)).toEqual(['hosted-graph']);
  });

  it('checks again after a growing pause while authority is unavailable, then activates', async () => {
    const h = host([row('new-graph')], {
      answers: [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, ALLOWED(1001n)],
    });
    const demand = new StorageAckDemandActivations(h.ports);
    const startedAt = Date.now();

    demand.request('new-graph', '1001');
    // The publisher keeps asking while it waits.
    for (let second = 0; second < 10; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      demand.request('new-graph', '1001');
    }
    await demand.whenIdle();

    expect(h.checks.map((check) => check.at - startedAt)).toEqual([0, 1_000, 3_000, 7_000]);
    expect(h.activations.map((activation) => activation.at - startedAt)).toEqual([7_000]);
  });

  it('runs one check per row however many requests arrive, and two rows at a time', async () => {
    let release!: () => void;
    const held = new Promise<ContextGraphReadAuthorityDecision>((resolve) => {
      release = () => resolve(ALLOWED(1n));
    });
    const h = host([row('a'), row('b'), row('c')], { answers: [() => held] });
    const demand = new StorageAckDemandActivations(h.ports);

    for (let i = 0; i < 20; i += 1) {
      expect(demand.request('a', '1')).toBe(true);
      expect(demand.request('b', '2')).toBe(true);
      expect(demand.request('c', '3')).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.checks.map((check) => check.binding.contextGraphId)).toEqual(['a', 'b']);
    expect(demand.size).toBe(3);

    release();
    await demand.whenIdle();
    expect(h.checks.map((check) => check.binding.contextGraphId)).toEqual(['a', 'b', 'c']);
    expect(h.activations.map((activation) => activation.id).sort()).toEqual(['a', 'b', 'c']);
    expect(demand.size).toBe(0);
  });

  it('leaves the row to the paced owners when it holds as many rows as it may', async () => {
    const h = host([row('a'), row('b'), row('c')], { answers: [() => new Promise(() => undefined)] });
    const demand = new StorageAckDemandActivations(h.ports, { maxConcurrent: 1, maxRows: 2 });

    expect(demand.request('a', '1')).toBe(true);
    expect(demand.request('b', '2')).toBe(true);
    expect(demand.request('c', '3')).toBe(false);
  });

  it('does not let a row whose checks keep failing hold up the next graph', async () => {
    const h = host([row('stuck'), row('next')]);
    h.ports.resolveAuthority = async (binding) => {
      h.checks.push({ binding: { ...binding }, at: Date.now() });
      return binding.contextGraphId === 'stuck' ? UNAVAILABLE : ALLOWED(BigInt(binding.onChainId!));
    };
    const demand = new StorageAckDemandActivations(h.ports, { maxConcurrent: 1 });
    const startedAt = Date.now();

    demand.request('stuck', '1');
    await vi.advanceTimersByTimeAsync(0);
    demand.request('next', '2');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.activations.map((activation) => [activation.id, activation.at - startedAt])).toEqual([['next', 0]]);
    expect(demand.size).toBe(1);
  });

  it('records a denial as final and activates nothing', async () => {
    const h = host([row('private-graph')], { answers: [DENIED] });
    const demand = new StorageAckDemandActivations(h.ports);

    demand.request('private-graph', '9');
    await demand.whenIdle();

    expect(h.retired).toEqual([{ id: 'private-graph', reason: 'authorityDenied' }]);
    expect(h.activations).toEqual([]);
  });

  it('leaves a row saved under another on-chain id to the paced owners', async () => {
    const h = host([row('rebound', { onChainId: '7' })]);
    const demand = new StorageAckDemandActivations(h.ports);

    demand.request('rebound', '8');
    await demand.whenIdle();

    expect(h.checks).toEqual([]);
    expect(h.activations).toEqual([]);
    expect(h.dormancy.get('rebound')).toBe('activationCap');
  });

  it('declines rows that are not dormant for a reason that clears, and before rehydration', async () => {
    const h = host([row('disabled')], { dormancy: 'rehydrationDisabled' });
    expect(new StorageAckDemandActivations(h.ports).request('disabled', '1')).toBe(false);
    expect(new StorageAckDemandActivations(h.ports).request('unknown', '1')).toBe(false);

    const early = host([row('early')], { current: false });
    expect(new StorageAckDemandActivations(early.ports).request('early', '1')).toBe(false);
  });

  it('stops checking once requests stop, and after ten minutes of requests', async () => {
    const idle = host([row('quiet')], { answers: [UNAVAILABLE] });
    const quiet = new StorageAckDemandActivations(idle.ports);
    quiet.request('quiet', '1');
    await vi.advanceTimersByTimeAsync(STORAGE_ACK_DEMAND_IDLE_MS + 10_000);
    await quiet.whenIdle();
    expect(quiet.size).toBe(0);
    expect(idle.activations).toEqual([]);
    expect(idle.dormancy.get('quiet')).toBe('activationCap');

    const busy = host([row('busy')], { answers: [UNAVAILABLE] });
    const asked = new StorageAckDemandActivations(busy.ports);
    const startedAt = Date.now();
    asked.request('busy', '1');
    // The gate stops asking after its own ten-minute window, as here.
    while (Date.now() - startedAt < STORAGE_ACK_DEMAND_MAX_MS + 60_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      if (Date.now() - startedAt < STORAGE_ACK_DEMAND_MAX_MS) asked.request('busy', '1');
    }
    expect(asked.size).toBe(0);
    const lastCheck = busy.checks.at(-1)!.at - startedAt;
    expect(lastCheck).toBeLessThan(STORAGE_ACK_DEMAND_MAX_MS);
    // Paused at most ten seconds between checks.
    expect(busy.checks.length).toBeGreaterThan(STORAGE_ACK_DEMAND_MAX_MS / 10_000 - 5);
  });

  it('stops at once when the node stops', async () => {
    const h = host([row('stopping')], { answers: [UNAVAILABLE] });
    const demand = new StorageAckDemandActivations(h.ports);
    demand.request('stopping', '1');
    await vi.advanceTimersByTimeAsync(0);

    h.controller.abort();
    await demand.whenIdle();

    expect(h.checks).toHaveLength(1);
    expect(demand.request('stopping', '1')).toBe(false);
  });

  it('checks again when the saved row changed under the check', async () => {
    const h = host([row('moving')], {
      answers: [async () => {
        h.revisions.set('moving', 1);
        h.saved.set('moving', row('moving', { onChainId: '5' }));
        return ALLOWED(5n);
      }, ALLOWED(5n)],
    });
    const demand = new StorageAckDemandActivations(h.ports);

    demand.request('moving', '5');
    await vi.advanceTimersByTimeAsync(5_000);
    await demand.whenIdle();

    expect(h.checks.map((check) => check.binding.onChainId)).toEqual(['5', '5']);
    expect(h.activations.map((activation) => activation.onChainId)).toEqual(['5']);
  });

  it('leaves a row another owner activated meanwhile', async () => {
    const h = host([row('raced')], {
      answers: [async () => {
        h.dormancy.delete('raced');
        h.subscriptions.set('raced', { syncMode: 'always-on', subscribed: true, synced: false });
        return ALLOWED(3n);
      }],
    });
    const demand = new StorageAckDemandActivations(h.ports);

    demand.request('raced', '3');
    await vi.advanceTimersByTimeAsync(5_000);
    await demand.whenIdle();

    expect(h.checks).toHaveLength(1);
    expect(h.activations).toEqual([]);
  });
});
