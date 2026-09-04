import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../src/dkg-agent-constants.js';

const MEMBER = '0x0000000000000000000000000000000000000001';
const NON_MEMBER = '0x00000000000000000000000000000000000000ff';

const registeredBinding = (onChainId: bigint) => ({
  kind: 'registered' as const,
  onChainId,
  provenance: 'numeric-id' as const,
});

describe('private read authorization uses the on-chain participant roster', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    vi.useRealTimers();
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
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
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
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(7n);
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);

    await expect(agent.canReadContextGraph('cold-private', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(resolveByNameHash).toHaveBeenCalledWith(
      agent.contextGraphNameCommitment('cold-private'),
      { signal: expect.any(AbortSignal) },
    );
    expect(localPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['cold', false, 'chain-name-binding-unavailable'],
    ['locally indexed', true, 'local-chain-binding-unavailable'],
  ] as const)(
    'bounds a never-settling %s name binding and fails read admission closed',
    async (_label, locallyIndexed, reason) => {
      const contextGraphId = locallyIndexed ? 'indexed-hung-binding' : 'cold-hung-binding';
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({
        name: locallyIndexed ? 'PrivateReadIndexedHungBinding' : 'PrivateReadColdHungBinding',
        chainAdapter: chain,
      });
      const nameHash = agent.contextGraphNameCommitment(contextGraphId);
      if (locallyIndexed) {
        agent.setContextGraphSubscription(contextGraphId, {
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          onChainHash: nameHash,
        }, { persist: false });
      }
      const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
        .mockReturnValue(new Promise<bigint | null>(() => undefined));
      const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);
      vi.useFakeTimers();

      const read = agent.resolveContextGraphReadAuthority(contextGraphId, {
        callerAgentAddress: MEMBER,
        allowSubscriptionFallback: false,
      });
      await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

      await expect(read).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason,
      });
      expect(resolveByNameHash).toHaveBeenCalledWith(
        nameHash,
        { signal: expect.any(AbortSignal) },
      );
      const operationSignal = resolveByNameHash.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(true);
      expect(localPolicy).not.toHaveBeenCalled();
    },
  );

  it('allows a cold registered graph only after fresh chain policy proves it public', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicReadColdNameHashAuthority',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
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

  it('does not expose a numeric local graph through an unrelated public chain slot', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'NumericLocalGraphChainSlotCollision',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'contextGraphExists').mockResolvedValue(true);
    vi.spyOn(chain, 'resolveContextGraphIdByNameHash').mockResolvedValue(null);
    vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(true);
    vi.spyOn(agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);
    vi.spyOn(agent, 'getContextGraphAgentGateAddresses').mockResolvedValue([MEMBER]);
    const chainPolicy = vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(0);

    await expect(agent.resolveContextGraphReadAuthority('42', {
      callerAgentAddress: NON_MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'denied',
      source: 'legacy-local',
      reason: 'local-agent-not-allowed',
    });
    expect(chainPolicy).not.toHaveBeenCalled();
  });

  it('does not make a chain-proven public graph depend on legacy peer metadata', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicReadIndependentOfLegacyPeerMetadata',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(8n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(0);
    const legacyPeers = vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockRejectedValue(new Error('local metadata store unavailable'));

    await expect(agent.resolveContextGraphReadAuthority('registered-public', {
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'registered-chain',
      reason: 'chain-public',
      onChainId: 8n,
    });
    expect(legacyPeers).not.toHaveBeenCalled();
  });

  it('denies a chain-authorized private participant when this peer is not allowed', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadPeerMismatch',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockResolvedValue(['12D3KooWAnotherAuthorizedPeer']);
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('12D3KooWLocalPeer');

    await expect(agent.resolveContextGraphReadAuthority('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'denied',
      source: 'registered-chain',
      reason: 'local-peer-not-allowed',
      onChainId: 7n,
    });
  });

  it('reports unavailable authority when private peer metadata cannot be read', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadPeerAuthorityUnavailable',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockRejectedValue(new Error('peer metadata unavailable'));

    await expect(agent.resolveContextGraphReadAuthority('registered-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'peer-authority-unavailable',
      onChainId: 7n,
    });
  });

  it('uses cold name-hash discovery for recovery and sender-key agent gates', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateColdRecoveryAgentGate',
      chainAdapter: chain,
    });
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockResolvedValue(9n);
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);
    const rfc64Roster = vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1')
      .mockReturnValue([NON_MEMBER]);
    const localMeta = vi.spyOn(agent, 'getCgMeta');

    await expect(agent.getContextGraphAgentGateAddresses('cold-private-gate'))
      .resolves.toEqual([MEMBER]);
    await expect(agent.getMemberRecoveryGate('cold-private-gate'))
      .resolves.toEqual([MEMBER]);
    expect(resolveByNameHash).toHaveBeenCalledTimes(2);
    expect(rfc64Roster).not.toHaveBeenCalled();
    expect(localMeta).not.toHaveBeenCalled();
  });

  it('does not reinterpret a registered public graph participant roster as its local publisher gate', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicRegisteredAgentGate',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(8n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(0);
    const chainRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue([NON_MEMBER]);
    vi.spyOn(agent, 'resolveRfc64PrivateReadRosterV1').mockReturnValue(undefined);
    vi.spyOn(agent, 'getCgMeta').mockResolvedValue({
      allowedAgents: [MEMBER],
      participantAgents: [],
      revokedAgents: [],
    } as Awaited<ReturnType<DKGAgent['getCgMeta']>>);

    await expect(agent.getContextGraphAgentGateAddresses('registered-public'))
      .resolves.toEqual([MEMBER]);
    expect(chainRoster).not.toHaveBeenCalled();
  });

  it('keeps registered-public publisher invitations out of the private read roster', async () => {
    const contextGraphId = 'registered-public-publisher-invite';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PublicRegisteredPublisherInvite',
      chainAdapter: chain,
    });
    const ownerRecord = await agent.registerAgent('Public graph owner');
    const publisherRecord = await agent.registerAgent('Public graph publisher');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Registered public publisher invite',
      accessPolicy: 0,
      publishPolicy: 0,
      callerAgentAddress: ownerRecord.agentAddress,
    });
    const registration = await agent.registerContextGraph(contextGraphId, {
      callerAgentAddress: ownerRecord.agentAddress,
    });
    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');

    await agent.inviteAgentToContextGraph(
      contextGraphId,
      publisherRecord.agentAddress,
      ownerRecord.agentAddress,
    );

    expect(addParticipant).not.toHaveBeenCalled();
    await expect(chain.getContextGraphParticipantAgents(BigInt(registration.onChainId)))
      .resolves.not.toContain(publisherRecord.agentAddress);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(publisherRecord.agentAddress);
  });

  it('does not treat a failed local chain binding read as proof of an unregistered graph', async () => {
    const chain = new MockChainAdapter();
    // Model an older adapter without the independent name-hash reverse lookup:
    // a failed local binding read must remain unavailable, never fall through
    // to a permissive local-public projection.
    (chain as unknown as { resolveContextGraphIdByNameHash?: unknown })
      .resolveContextGraphIdByNameHash = undefined;
    agent = await DKGAgent.create({
      name: 'PrivateReadBindingUnavailable',
      chainAdapter: chain,
    });
    agent.setContextGraphSubscription('possibly-registered', {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
    }, { persist: false });
    vi.spyOn(agent.store, 'query')
      .mockRejectedValue(new Error('local mapping store unavailable'));
    const localPolicy = vi.spyOn(agent, 'isPrivateContextGraph').mockResolvedValue(false);

    await expect(agent.resolveContextGraphReadAuthority('possibly-registered', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'local-chain-binding-unavailable',
    });
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
      vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
        .mockResolvedValue(registeredBinding(7n));
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

  it('bounds a never-settling registered participant roster and fails read admission closed', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadHungRoster',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    vi.useFakeTimers();

    const read = agent.resolveContextGraphReadAuthority('hung-private', {
      callerAgentAddress: MEMBER,
      allowSubscriptionFallback: false,
    });
    await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

    await expect(read).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('propagates caller abort to a stalled registered participant lookup', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadAbortedRoster',
      chainAdapter: chain,
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    const controller = new AbortController();
    vi.useFakeTimers();
    const startedAt = Date.now();

    let settled = false;
    const gate = agent.getContextGraphAgentGateAddresses('aborted-private', {
      signal: controller.signal,
    }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    controller.abort(new Error('caller stopped'));
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(Date.now()).toBe(startedAt);
    await expect(gate).resolves.toEqual([]);
  });

  it('requires every chain sender-key recipient to advertise an allowed peer when a peer gate exists', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadSenderKeyPeerGate',
      chainAdapter: chain,
    });
    const member = await agent.registerAgent('Sender-key peer-gated member');
    const advertisedPeer = '12D3KooWSenderKeyAuthorizedPeer';
    await agent.store.insert([{
      subject: `did:dkg:agent:${member.agentAddress}`,
      predicate: 'https://dkg.network/ontology#peerId',
      object: `"${advertisedPeer}"`,
      graph: 'did:dkg:system/agents',
    }]);
    vi.spyOn(agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({
      kind: 'private',
      onChainId: 7n,
      participantAgents: [member.agentAddress],
    });
    const allowedPeers = vi.spyOn(agent, 'getContextGraphAllowedPeers')
      .mockResolvedValue(null);

    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).resolves.toMatchObject({
      requiresEncryption: true,
      recipients: [expect.objectContaining({
        agentAddress: member.agentAddress,
        peerId: advertisedPeer,
      })],
    });

    allowedPeers.mockResolvedValue([advertisedPeer]);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).resolves.toMatchObject({
      requiresEncryption: true,
      recipients: [expect.objectContaining({ peerId: advertisedPeer })],
    });

    allowedPeers.mockResolvedValue(['12D3KooWAnotherAuthorizedPeer']);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId: 'registered-private-peer-gate',
    })).rejects.toThrow(/has no recipient key advertised by a peer in the context graph allowlist/);
  });

  it('does not let a never-settling registered roster block subscription rehydration', async () => {
    const contextGraphId = 'persisted-hung-roster';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadHungRosterRehydration',
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
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue(registeredBinding(7n));
    vi.spyOn(agent, 'readLiveOnChainAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockReturnValue(new Promise<string[]>(() => undefined));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      agent.start(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('daemon startup exceeded the roster-read deadline')),
          CHAIN_POLICY_READ_TIMEOUT_MS + 1_500,
        );
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [contextGraphId],
      },
    });
  }, CHAIN_POLICY_READ_TIMEOUT_MS + 3_500);

  it('does not let cold name-binding discovery block subscription rehydration', async () => {
    const contextGraphId = 'persisted-hung-name-binding';
    const chain = new MockChainAdapter();
    const resolveByNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash')
      .mockReturnValue(new Promise<bigint | null>(() => undefined));
    agent = await DKGAgent.create({
      name: 'PrivateReadHungNameBindingRehydration',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      agent.start(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('daemon startup exceeded the name-binding deadline')),
          CHAIN_POLICY_READ_TIMEOUT_MS + 1_500,
        );
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    expect(resolveByNameHash).toHaveBeenCalledWith(
      agent.contextGraphNameCommitment(contextGraphId),
      { signal: expect.any(AbortSignal) },
    );
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityUnavailable: [contextGraphId],
      },
    });
  }, CHAIN_POLICY_READ_TIMEOUT_MS + 3_500);

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
    const readAuthority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'test-chain-unavailable',
      metadataBootstrap: 'eligible',
    });
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');

    await agent.rehydrateContextGraphSubscriptions();

    expect(readAuthority).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 1,
      activated: 0,
      dormant: 1,
      dormantIds: [contextGraphId],
      dormantReasons: {
        activationCap: [],
        authorityDenied: [],
        authorityUnavailable: [contextGraphId],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });

    const mutableSnapshot = agent.getContextGraphSubscriptionRehydrationStatus();
    expect(mutableSnapshot).not.toBeNull();
    mutableSnapshot!.hostedActivatedIds.push('mutated-hosted');
    mutableSnapshot!.dormantIds.length = 0;
    for (const ids of Object.values(mutableSnapshot!.dormantReasons)) {
      ids.push('mutated-reason');
    }
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      hostedActivatedIds: [],
      dormantIds: [contextGraphId],
      dormantReasons: {
        activationCap: [],
        authorityDenied: [],
        authorityUnavailable: [contextGraphId],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });
  });

  it('uses the real no-caller chain decision when rehydrating member and non-member rows', async () => {
    const nonMemberContextGraphId = 'recovery-a-denied';
    const memberContextGraphId = 'recovery-b-member';
    const capContextGraphId = 'recovery-z-cap';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadRealRehydrationAuthority',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [memberContextGraphId, nonMemberContextGraphId, capContextGraphId].map((id) => ({
          id,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        })),
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
      maxRehydratedContextGraphSubscriptions: 1,
    });
    const localAgentRecord = await agent.registerAgent('Recovery member');
    await agent.markDefaultAgent(localAgentRecord.agentAddress);
    const localAgent = localAgentRecord.agentAddress;
    const memberGraph = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [localAgent],
    });
    const nonMemberGraph = await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [NON_MEMBER],
    });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id) => {
      if (id === memberContextGraphId) return registeredBinding(memberGraph.contextGraphId);
      if (id === nonMemberContextGraphId) return registeredBinding(nonMemberGraph.contextGraphId);
      return { kind: 'unregistered' };
    });
    // start() drives the real background recovery entry point after the local
    // agent and chain rosters have both been seeded.
    await agent.start();

    expect(agent.getSubscribedContextGraphs().has(memberContextGraphId)).toBe(true);
    expect(agent.getSubscribedContextGraphs().has(nonMemberContextGraphId)).toBe(false);
    expect(agent.getSubscribedContextGraphs().has(capContextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      persistedTotal: 3,
      activated: 1,
      dormant: 2,
      dormantIds: [nonMemberContextGraphId, capContextGraphId],
      dormantReasons: {
        activationCap: [capContextGraphId],
        authorityDenied: [nonMemberContextGraphId],
        authorityUnavailable: [],
        rehydrationDisabled: [],
        deactivated: [],
      },
    });
  });

  it('keeps restarted join approvals metadata-only until ordinary read authority is proven', async () => {
    const contextGraphId = 'restart-pending-join-approval';
    const curatorPeerId = '12D3KooWRestartPendingCurator';
    agent = await DKGAgent.create({
      name: 'PendingJoinApprovalRecovery',
      chainAdapter: new MockChainAdapter(),
    });
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWRestartPendingMember',
      configurable: true,
    });
    const local = await agent.registerAgent('Pending approval member');
    await agent.markDefaultAgent(local.agentAddress);
    (agent as unknown as {
      localApprovedAgentByCG: Map<string, string>;
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).localApprovedAgentByCG.set(contextGraphId, local.agentAddress.toLowerCase());
    (agent as unknown as {
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    });

    const refreshMeta = vi.spyOn(agent, 'refreshMetaFromCurator')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const hasConfirmedMeta = vi.spyOn(agent, 'hasConfirmedMetaState').mockResolvedValue(true);
    const readAuthority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: 'allowed',
      source: 'legacy-local',
      reason: 'local-agent-allowlist',
      metadataBootstrap: 'eligible',
    });
    const refreshFlags = vi.spyOn(agent, 'refreshMetaSyncedFlags').mockResolvedValue(undefined);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph').mockImplementation(
      () => (agent as DKGAgent).getSubscribedContextGraphs().get(contextGraphId)!,
    );
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership')
      .mockImplementation(() => undefined);
    const catchUp = vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);
    expect(readAuthority).not.toHaveBeenCalled();
    expect(refreshFlags).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(persistMembership).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);
    expect(refreshMeta).toHaveBeenLastCalledWith(contextGraphId, expect.objectContaining({
      trustedCuratorPeerId: curatorPeerId,
      force: true,
      memberProof: expect.objectContaining({
        approvedAgentAddress: local.agentAddress.toLowerCase(),
      }),
    }));
    expect(hasConfirmedMeta).toHaveBeenCalledWith(contextGraphId);
    expect(readAuthority).toHaveBeenCalledWith(contextGraphId, {
      allowSubscriptionFallback: false,
    });
    expect(refreshFlags).toHaveBeenCalledWith([contextGraphId]);
    expect(subscribe).toHaveBeenCalledWith(contextGraphId, {
      persist: false,
      syncMode: 'always-on',
    });
    expect(persistMembership).toHaveBeenCalledWith(
      contextGraphId,
      'rehydrated-subscription',
    );
    expect(catchUp).toHaveBeenCalledWith(contextGraphId, curatorPeerId);
  });

  it.each([
    { outcome: 'denied' as const, metadataBootstrap: 'forbidden' as const },
    { outcome: 'unavailable' as const, metadataBootstrap: 'eligible' as const },
  ])('keeps every data lane closed when post-refresh authority is $outcome', async (decision) => {
    const contextGraphId = `post-refresh-${decision.outcome}`;
    const curatorPeerId = '12D3KooWPostRefreshAuthorityCurator';
    agent = await DKGAgent.create({
      name: `PostRefreshAuthority-${decision.outcome}`,
      chainAdapter: new MockChainAdapter(),
    });
    Object.defineProperty(agent, 'peerId', {
      value: `12D3KooWPostRefresh${decision.outcome}`,
      configurable: true,
    });
    const local = await agent.registerAgent(`Post-refresh ${decision.outcome} member`);
    (agent as unknown as { localApprovedAgentByCG: Map<string, string> })
      .localApprovedAgentByCG.set(contextGraphId, local.agentAddress.toLowerCase());
    (agent as unknown as {
      subscribedContextGraphs: Map<string, Record<string, unknown>>;
    }).subscribedContextGraphs.set(contextGraphId, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    });

    vi.spyOn(agent, 'refreshMetaFromCurator').mockResolvedValue(true);
    vi.spyOn(agent, 'hasConfirmedMetaState').mockResolvedValue(true);
    vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValue({
      outcome: decision.outcome,
      source: 'registered-chain',
      reason: `test-${decision.outcome}`,
      metadataBootstrap: decision.metadataBootstrap,
    });
    const refreshFlags = vi.spyOn(agent, 'refreshMetaSyncedFlags').mockResolvedValue(undefined);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const persistMembership = vi.spyOn(agent, 'persistLocalNodeMembership');
    const catchUp = vi.spyOn(agent, 'runImmediatePostApprovalSync').mockResolvedValue(undefined);

    await agent.resumePendingJoinApprovalMetadata(contextGraphId, curatorPeerId);

    expect(refreshFlags).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(persistMembership).not.toHaveBeenCalled();
    expect(catchUp).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('keeps a restarted approval with no local metadata out of every data lane', async () => {
    const contextGraphId = 'restart-approval-no-metadata';
    const curatorPeerId = '12D3KooWRestartNoMetadataCurator';
    let localAgentAddress = MEMBER;
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PendingJoinApprovalNoMetadata',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphMembershipStore: {
        loadAll: async () => [{
          contextGraphId,
          principalType: 'agent' as const,
          principalId: localAgentAddress,
          role: 'participant',
          status: 'active' as const,
          source: 'join-approved',
          metadata: { curatorPeerId },
          updatedAt: 1,
        }],
        upsert: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const local = await agent.registerAgent('Restart no-metadata member');
    localAgentAddress = local.agentAddress;
    await agent.markDefaultAgent(localAgentAddress);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const resume = vi.spyOn(agent, 'resumePendingJoinApprovalMetadata')
      .mockResolvedValue(undefined);

    await agent.rehydrateContextGraphSubscriptions();

    expect(subscribe).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith(contextGraphId, curatorPeerId);
    expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    await expect(agent.resolveContextGraphReadAuthority(contextGraphId, {
      allowSubscriptionFallback: true,
    })).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'legacy-local',
      reason: 'pending-authoritative-metadata',
    });
    await expect(agent.canReadContextGraph(contextGraphId)).resolves.toBe(false);
  });

  it('does not let a stale durable approval override a current chain denial', async () => {
    const contextGraphId = 'restart-stale-approval-chain-denied';
    const curatorPeerId = '12D3KooWRestartRevokedCurator';
    let localAgentAddress = MEMBER;
    const chain = new MockChainAdapter();
    await chain.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      participantAgents: [NON_MEMBER],
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)),
    });
    agent = await DKGAgent.create({
      name: 'StaleJoinApprovalChainDenied',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          syncScoped: true,
        }],
        save: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphMembershipStore: {
        loadAll: async () => [{
          contextGraphId,
          principalType: 'agent' as const,
          principalId: localAgentAddress,
          role: 'participant',
          status: 'active' as const,
          source: 'join-approved',
          metadata: { curatorPeerId },
          updatedAt: 1,
        }],
        upsert: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionRehydrationEnabled: true,
    });
    const local = await agent.registerAgent('Revoked restart member');
    localAgentAddress = local.agentAddress;
    await agent.markDefaultAgent(localAgentAddress);
    const subscribe = vi.spyOn(agent, 'subscribeToContextGraph');
    const resume = vi.spyOn(agent, 'resumePendingJoinApprovalMetadata')
      .mockResolvedValue(undefined);

    await agent.rehydrateContextGraphSubscriptions();

    expect(subscribe).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(agent.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0,
      dormantIds: [contextGraphId],
      dormantReasons: {
        authorityDenied: [contextGraphId],
      },
    });
  });

  it('keeps registered invite and removal synchronized with chain read authority', async () => {
    const contextGraphId = 'registered-private-membership-mutation';
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'PrivateReadMembershipMutation',
      chainAdapter: chain,
    });
    const ownerRecord = await agent.registerAgent('Membership owner');
    const memberRecord = await agent.registerAgent('Membership participant');
    await agent.markDefaultAgent(ownerRecord.agentAddress);
    const owner = ownerRecord.agentAddress;
    const member = memberRecord.agentAddress;
    await agent.start();
    await agent.createContextGraph({
      id: contextGraphId,
      name: 'Registered private membership mutation',
      accessPolicy: 1,
      callerAgentAddress: owner,
    });
    const registration = await agent.registerContextGraph(contextGraphId, {
      callerAgentAddress: owner,
    });
    const onChainId = BigInt(registration.onChainId);

    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);

    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');
    addParticipant.mockRejectedValueOnce(new Error('chain add failed'));
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('chain add failed');
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);

    const participantRoster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
    addParticipant.mockResolvedValueOnce({
      hash: '0xunsuccessful',
      blockNumber: 0,
      success: false,
    });
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow(/Failed to add/);
    const rosterReadsAfterUnsuccessfulResult = participantRoster.mock.calls.length;
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);
    expect(participantRoster.mock.calls.length).toBeGreaterThan(rosterReadsAfterUnsuccessfulResult);

    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    expect(await chain.getContextGraphParticipantAgents(onChainId)).toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
    await expect(agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({ contextGraphId }))
      .resolves.toMatchObject({
        requiresEncryption: true,
        recipients: expect.arrayContaining([
          expect.objectContaining({ agentAddress: member }),
        ]),
      });

    const removeParticipant = vi.spyOn(chain, 'removeContextGraphParticipantAgent');
    removeParticipant.mockRejectedValueOnce(new Error('chain remove failed'));
    await expect(agent.removeAgentFromContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('chain remove failed');
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(member);

    // The authoritative chain mutation can succeed before a local store write
    // fails. Stale local metadata must not keep recovery or sender-key access
    // alive during that retry window (or after a restart).
    vi.spyOn(agent.store, 'deleteByPatternWithoutCount')
      .mockRejectedValueOnce(new Error('local membership delete failed'));
    await expect(agent.removeAgentFromContextGraph(contextGraphId, member.toLowerCase(), owner))
      .rejects.toThrow('local membership delete failed');
    expect(await chain.getContextGraphParticipantAgents(onChainId)).not.toContain(member);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.getContextGraphAgentGateAddresses(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.getMemberRecoveryGate(contextGraphId))
      .resolves.not.toContain(member);
    const postRemovalRecipients = await agent.resolveWorkspaceAgentRecipientsForCurrentAuthority({
      contextGraphId,
    });
    expect(postRemovalRecipients.requiresEncryption).toBe(true);
    if (postRemovalRecipients.requiresEncryption) {
      expect(postRemovalRecipients.recipients.map((recipient) => recipient.agentAddress))
        .not.toContain(member);
    }
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(false);

    // Retry completes the stale local half without repeating the already-done
    // chain removal. Use different address casing across removal/re-invite to
    // prove exact RDF literal matching cannot strand the tombstone.
    await agent.removeAgentFromContextGraph(contextGraphId, member.toLowerCase(), owner);

    // The inverse split can also happen: chain addition succeeds, then the
    // replacement local allowlist insert fails. The tombstone must remain
    // effective and a retry must complete locally without a duplicate tx.
    const addCallsBeforeRetryWindow = addParticipant.mock.calls.length;
    vi.spyOn(agent.store, 'insert').mockRejectedValueOnce(
      new Error('local membership insert failed'),
    );
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member, owner))
      .rejects.toThrow('local membership insert failed');
    expect(addParticipant).toHaveBeenCalledTimes(addCallsBeforeRetryWindow + 1);
    expect(await chain.getContextGraphParticipantAgents(onChainId)).toContain(member);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.not.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);

    await agent.inviteAgentToContextGraph(contextGraphId, member, owner);
    expect(addParticipant).toHaveBeenCalledTimes(addCallsBeforeRetryWindow + 1);
    await expect(agent.getContextGraphAllowedAgents(contextGraphId))
      .resolves.toContain(member);
    await expect(agent.canReadContextGraph(contextGraphId, {
      callerAgentAddress: member,
      allowSubscriptionFallback: false,
    })).resolves.toBe(true);
  });
});
