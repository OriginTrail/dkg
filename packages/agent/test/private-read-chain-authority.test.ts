import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

const MEMBER = '0x0000000000000000000000000000000000000001';
const NON_MEMBER = '0x00000000000000000000000000000000000000ff';

describe('private read authorization uses the on-chain participant roster', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('allows a chain participant and rejects a non-member without local metadata fallback', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadChainAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphNumericIdForPolicy').mockResolvedValue(7n);
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([MEMBER]);
    const localGate = vi.spyOn(agent, 'getContextGraphAgentGateAddresses')
      .mockResolvedValue([NON_MEMBER]);

    await expect(agent.canReadContextGraph('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    await expect(agent.canReadContextGraph('registered-private', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(chainRoster).toHaveBeenCalledTimes(2);
    expect(localGate).not.toHaveBeenCalled();
  });

  it('discovers a cold non-selected private CG by name hash and rejects a non-member', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadColdNameHashAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'resolveContextGraphNumericIdForPolicy').mockResolvedValue(null);
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(7n);
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);

    await expect(agent.canReadContextGraph('cold-private', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(resolveByNameHash).toHaveBeenCalledWith(agent.contextGraphNameCommitment('cold-private'));
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it('allows a cold registered graph only after fresh chain policy proves it public', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicReadColdNameHashAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'resolveContextGraphNumericIdForPolicy').mockResolvedValue(null);
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(8n);
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(0);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);

    await expect(agent.canReadContextGraph('cold-public', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    expect(chainRoster).not.toHaveBeenCalled();
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it.each(['empty', 'error'] as const)(
    'denies when registered chain authority is %s instead of falling back to stale local metadata',
    async (mode) => {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({
        name: `PrivateReadChainAuthority-${mode}`,
        chainAdapter: chain,
      });
      vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
      vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
      vi.spyOn(agent, 'resolveContextGraphNumericIdForPolicy').mockResolvedValue(7n);
      vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
      vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue([MEMBER]);
      const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
      if (mode === 'empty') chainRoster.mockResolvedValue([]);
      else chainRoster.mockRejectedValue(new Error('RPC unavailable'));

      await expect(agent.canReadContextGraph('registered-private', {
        callerAgentAddress: MEMBER,
        allowSubscriptionFallback: false,
      })).resolves.toBe(false);
    },
  );

  it('leaves a persisted subscription dormant when startup cannot prove current read authority', async () => {
    const contextGraphId = 'persisted-private-poison';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadRehydrationAuthority',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
          onChainId: '7',
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const canRead = vi.spyOn(agent, 'canReadContextGraph').mockResolvedValue(false);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');

    await agent.rehydrateContextGraphSubscriptions();

    expect(canRead).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 1,
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
    });
  });
});
