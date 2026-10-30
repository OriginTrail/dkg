// SPDX-License-Identifier: Apache-2.0

/**
 * A profile whose broadcast reached no admitted peer goes out again, a bounded
 * number of times (`src/p2p/agent-profile-resends.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_PROFILE_RESEND_DELAYS_MS,
  AgentProfileResends,
  agentProfileResendsFor,
} from '../src/p2p/agent-profile-resends.js';

function harness(options: { admitted?: readonly string[]; running?: boolean } = {}) {
  const admitted = new Set(options.admitted ?? ['peer-core']);
  let running = options.running ?? true;
  const info: string[] = [];
  const warn: string[] = [];
  const resends = new AgentProfileResends({
    isRunning: () => running,
    isAdmitted: (peerId) => admitted.has(peerId),
    logInfo: (message) => { info.push(message); },
    logWarn: (message) => { warn.push(message); },
  });
  return { resends, admitted, info, warn, stop: () => { running = false; } };
}

describe('sending an agent profile again', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends nothing more when an admitted peer got the broadcast', async () => {
    const { resends, info } = harness();
    const resend = vi.fn(async () => ['peer-core']);
    resends.track(['peer-core'], resend);
    await vi.runAllTimersAsync();
    expect(resend).not.toHaveBeenCalled();
    expect(info).toEqual([]);
  });

  it('sends nothing more when the pubsub does not say who got it', async () => {
    const { resends } = harness();
    const resend = vi.fn(async () => undefined);
    resends.track(undefined, resend);
    await vi.runAllTimersAsync();
    expect(resend).not.toHaveBeenCalled();
  });

  it('sends a profile no peer got again, after the first pause, and stops once an admitted peer gets it', async () => {
    const { resends, info } = harness();
    const resend = vi.fn(async () => ['peer-core']);
    resends.track([], resend);
    await vi.advanceTimersByTimeAsync(AGENT_PROFILE_RESEND_DELAYS_MS[0]! - 1);
    expect(resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resend).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(resend).toHaveBeenCalledTimes(1);
    expect(info.at(-1)).toContain('reached an admitted peer after 1 more send');
  });

  it('does not count a peer that has not been admitted yet as having got it', async () => {
    const { resends, admitted } = harness({ admitted: [] });
    const resend = vi.fn(async () => ['peer-joining']);
    resends.track(['peer-joining'], resend);
    await vi.advanceTimersByTimeAsync(AGENT_PROFILE_RESEND_DELAYS_MS[0]!);
    expect(resend).toHaveBeenCalledTimes(1);
    admitted.add('peer-joining');
    await vi.runAllTimersAsync();
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('gives up after every pause, leaving the profile to the next heartbeat', async () => {
    const { resends, warn } = harness();
    const resend = vi.fn(async () => []);
    resends.track([], resend);
    await vi.runAllTimersAsync();
    expect(resend).toHaveBeenCalledTimes(AGENT_PROFILE_RESEND_DELAYS_MS.length);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(`in ${AGENT_PROFILE_RESEND_DELAYS_MS.length + 1} sends`);
  });

  it('ends its pauses well before the next heartbeat', () => {
    const total = AGENT_PROFILE_RESEND_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeLessThan(20 * 60_000 / 2);
  });

  it('keeps going when a send fails', async () => {
    const { resends } = harness();
    const resend = vi.fn<() => Promise<readonly string[] | undefined>>()
      .mockRejectedValueOnce(new Error('stream reset'))
      .mockResolvedValue(['peer-core']);
    resends.track([], resend);
    await vi.runAllTimersAsync();
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it('lets a newer profile take over from one still being sent', async () => {
    const { resends } = harness();
    const older = vi.fn(async () => []);
    const newer = vi.fn(async () => ['peer-core']);
    resends.track([], older);
    await vi.advanceTimersByTimeAsync(AGENT_PROFILE_RESEND_DELAYS_MS[0]! - 1);
    resends.track([], newer);
    await vi.runAllTimersAsync();
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it('drops the answer of a send a newer profile overtook', async () => {
    const { resends } = harness();
    let answer!: (recipients: readonly string[]) => void;
    const older = vi.fn(() => new Promise<readonly string[]>((resolve) => { answer = resolve; }));
    const newer = vi.fn(async () => ['peer-core']);
    resends.track([], older);
    await vi.advanceTimersByTimeAsync(AGENT_PROFILE_RESEND_DELAYS_MS[0]!);
    resends.track(['peer-core'], newer);
    answer([]);
    await vi.runAllTimersAsync();
    expect(older).toHaveBeenCalledTimes(1);
    expect(newer).not.toHaveBeenCalled();
  });

  it('sends nothing on a node that has stopped', async () => {
    const { resends, stop } = harness();
    const resend = vi.fn(async () => []);
    resends.track([], resend);
    stop();
    await vi.runAllTimersAsync();
    expect(resend).not.toHaveBeenCalled();
  });

  it('is kept per agent, the same one every time', () => {
    const host = {};
    const create = vi.fn(() => harness().resends);
    const first = agentProfileResendsFor(host, create);
    expect(agentProfileResendsFor(host, create)).toBe(first);
    expect(agentProfileResendsFor({}, create)).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
