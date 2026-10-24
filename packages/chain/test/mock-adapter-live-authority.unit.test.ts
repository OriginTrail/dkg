// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';

const MEMBER = ethers.getAddress('0x00000000000000000000000000000000000000a1');

function mock(): MockChainAdapter {
  return new MockChainAdapter('mock:31337', MOCK_DEFAULT_SIGNER);
}

/**
 * The mock's one-read authority is COMPOSED from its three point reads, so a
 * suite that stubs or spies any of them keeps observing the calls it always
 * did. These cases pin that composition: which reads run, in what order, and
 * with what arity.
 */
describe('MockChainAdapter: live context graph authority', () => {
  it('answers a private graph from liveness, then policy, then roster', async () => {
    const chain = mock();
    const { contextGraphId } = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [MEMBER],
    });
    const liveness = vi.spyOn(chain, 'isContextGraphActiveOnChain');
    const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(chain.getContextGraphLiveAuthority(contextGraphId)).resolves.toEqual({
      active: true,
      accessPolicy: 1,
      participantAgents: [MEMBER],
    });
    expect(liveness.mock.invocationCallOrder[0]).toBeLessThan(policy.mock.invocationCallOrder[0]);
    expect(policy.mock.invocationCallOrder[0]).toBeLessThan(roster.mock.invocationCallOrder[0]);
  });

  it('never reads the roster of a public graph', async () => {
    const chain = mock();
    const { contextGraphId } = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      participantAgents: [MEMBER],
    });
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(chain.getContextGraphLiveAuthority(contextGraphId)).resolves.toEqual({
      active: true,
      accessPolicy: 0,
      participantAgents: [],
    });
    expect(roster).not.toHaveBeenCalled();
  });

  it('reports an unknown graph as inactive, never null, and reads nothing past liveness', async () => {
    const chain = mock();
    const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(chain.getContextGraphLiveAuthority(404n)).resolves.toEqual({
      active: false,
      accessPolicy: 0,
      participantAgents: [],
    });
    expect(policy).not.toHaveBeenCalled();
    expect(roster).not.toHaveBeenCalled();
  });

  it('keeps the point reads at the arity their spies pin: options only with a signal', async () => {
    const chain = mock();
    const { contextGraphId } = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const liveness = vi.spyOn(chain, 'isContextGraphActiveOnChain');
    const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');

    await chain.getContextGraphLiveAuthority(contextGraphId);
    expect(liveness.mock.calls[0]).toEqual([contextGraphId]);
    expect(policy.mock.calls[0]).toEqual([contextGraphId]);

    const { signal } = new AbortController();
    await chain.getContextGraphLiveAuthority(contextGraphId, { signal });
    expect(liveness.mock.calls[1]).toEqual([contextGraphId, { signal }]);
    expect(policy.mock.calls[1]).toEqual([contextGraphId, { signal }]);
  });

  it('honours a caller that already stopped, before any read', async () => {
    const chain = mock();
    const liveness = vi.spyOn(chain, 'isContextGraphActiveOnChain');
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    controller.abort(reason);

    await expect(chain.getContextGraphLiveAuthority(1n, { signal: controller.signal })).rejects.toBe(reason);
    expect(liveness).not.toHaveBeenCalled();
  });
});
