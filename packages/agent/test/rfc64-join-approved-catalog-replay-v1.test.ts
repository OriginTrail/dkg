// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext, MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import type { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(agents.splice(0).map((agent) => agent.stop()));
  vi.restoreAllMocks();
});

async function fixture() {
  const agent = await DKGAgent.create({ name: 'ReplayOwner', chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  const dispatcher = Reflect.get(agent, 'rfc64BackgroundWorkDispatcherV1') as Rfc64BackgroundWorkDispatcherV1;
  const refresh = vi.spyOn(agent, 'reconcileRfc64CatalogAccessAuthorityV1').mockResolvedValue(null);
  const replay = vi.spyOn(agent, 'reannounceRfc64CatalogAfterJoinApprovalV1').mockResolvedValue(true);
  return { agent, dispatcher, refresh, replay };
}

describe('agent-owned join approval catalog replay', () => {
  it('settles overlapping same-key foreground calls after their held attempts complete', async () => {
    const { agent, dispatcher, refresh } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    refresh.mockImplementation(async () => { await gate; return null; });
    vi.useFakeTimers();
    let settled = 0;
    const run = () => agent.runRfc64CatalogAfterJoinApprovalV1('cg', 'agent', 'peer').then(() => { settled += 1; });
    const first = run(); const second = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.whenIdle();
    expect(settled).toBe(2);
    await Promise.all([first, second]);
  });

  it('settles a new foreground call while an earlier background retry remains active', async () => {
    const { agent, dispatcher, refresh, replay } = await fixture();
    const classes: string[] = [];
    refresh.mockImplementation(async () => { classes.push(activeRpcRequestContext().requestClass); return null; });
    replay.mockResolvedValue(false);
    vi.useFakeTimers();
    const first = agent.runRfc64CatalogAfterJoinApprovalV1('cg', 'agent', 'peer');
    await vi.advanceTimersByTimeAsync(1_250);
    await first;
    expect(classes).toEqual(['foreground', 'foreground', 'foreground']);
    replay.mockResolvedValue(true);
    let settled = false;
    const second = agent.runRfc64CatalogAfterJoinApprovalV1('cg', 'agent', 'peer').then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await second;
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.whenIdle();
    expect(classes).toEqual(['foreground', 'foreground', 'foreground', 'foreground', 'background']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(classes).toHaveLength(5);
  });

  it('retains both bounded delay sequences and warns only after background exhaustion', async () => {
    const { agent, dispatcher, refresh, replay } = await fixture();
    replay.mockResolvedValue(false);
    const warn = vi.spyOn(Reflect.get(agent, 'log'), 'warn');
    vi.useFakeTimers();
    const foreground = agent.runRfc64CatalogAfterJoinApprovalV1('cg', 'agent', 'peer');
    await vi.advanceTimersByTimeAsync(1_250); await foreground;
    expect(refresh).toHaveBeenCalledTimes(3); expect(warn).not.toHaveBeenCalled();
    let attempts = 3;
    for (const delayMs of [5_000, 15_000, 30_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(refresh).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledTimes(++attempts);
    }
    await dispatcher.whenIdle();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('bounded join approval retries'));
  });

  it('settles and physically drains every foreground caller on shutdown cancellation', async () => {
    const { agent, dispatcher, refresh } = await fixture();
    refresh.mockImplementation(async (_id, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return null;
    });
    vi.useFakeTimers();
    const run = () => agent.runRfc64CatalogAfterJoinApprovalV1('cg', 'agent', 'peer').catch((error: unknown) => error);
    const first = run(); const second = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    await dispatcher.closeAndDrain();
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ name: 'AbortError' });
    await dispatcher.whenIdle();
  });
});
