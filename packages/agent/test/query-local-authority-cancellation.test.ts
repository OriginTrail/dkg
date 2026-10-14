// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { QueryMethods } from '../src/dkg-agent-query.js';

function fixture() {
  return {
    config: {}, peerId: 'local-peer', subscribedContextGraphs: new Map(),
    resolveRegisteredContextGraphAuthority: vi.fn(async () => ({ kind: 'unregistered' as const })),
    resolveRfc64PrivateReadRosterV1: () => undefined,
    isPrivateContextGraph: vi.fn(async (_id: string, _options?: { signal?: AbortSignal }) => true),
    getContextGraphAllowedPeers: vi.fn(async (_id: string, _options?: { signal?: AbortSignal }): Promise<string[] | null> => null),
    getContextGraphAgentGateAddresses: vi.fn(async (_id: string, _options?: { signal?: AbortSignal }): Promise<string[] | null> => null),
    getPrivateContextGraphParticipants: vi.fn(async (_id: string, _options?: { signal?: AbortSignal }): Promise<string[] | null> => ['42']),
    chain: { getIdentityId: vi.fn(async () => 42n) },
  };
}
const stages = ['isPrivateContextGraph', 'getContextGraphAllowedPeers',
  'getContextGraphAgentGateAddresses', 'getPrivateContextGraphParticipants'] as const;

describe('query local authority cancellation', () => {
  it.each(stages)('starts no later gate after cancellation during %s', async stage => {
    const host = fixture(), controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const original = host[stage].getMockImplementation()!;
    const delayed = vi.fn(async (id: string, options?: { signal?: AbortSignal }) => {
      entered(); await pending;
      return original(id, options);
    });
    Object.assign(host, { [stage]: delayed });
    const result = QueryMethods.prototype.resolveContextGraphReadAuthority.call(host as never, 'legacy-private', { signal: controller.signal });
    await started;
    controller.abort(new Error('request deadline'));
    release();
    await expect(result).resolves.toMatchObject({ outcome: 'unavailable' });
    expect(delayed).toHaveBeenCalledWith('legacy-private', { signal: controller.signal });
    for (const later of stages.slice(stages.indexOf(stage) + 1)) expect(host[later]).not.toHaveBeenCalled();
    expect(host.chain.getIdentityId).not.toHaveBeenCalled();
  });

  it('still authorizes an ordinary legacy participant and forwards the same signal', async () => {
    const host = fixture(), { signal } = new AbortController();
    await expect(QueryMethods.prototype.resolveContextGraphReadAuthority.call(host as never, 'legacy-private', { signal }))
      .resolves.toMatchObject({ outcome: 'allowed', reason: 'legacy-local-identity-participant' });
    for (const stage of stages) expect(host[stage]).toHaveBeenCalledWith('legacy-private', { signal });
    expect(host.chain.getIdentityId).toHaveBeenCalledTimes(1);
  });
});
