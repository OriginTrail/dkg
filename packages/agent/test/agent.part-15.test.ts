import { describe, it, expect, beforeAll, afterAll, vi, DKGAgentWallet, buildAgentProfile, collectPublishableMultiaddrs, CclEvaluator, DiscoveryClient, ProfileManager, encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret, DKGAgent, AGENT_REGISTRY_CONTEXT_GRAPH, parseCclPolicy, OxigraphStore, getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphWorkspaceGraphUri, contextGraphMetaUri, sparqlString, DKGQueryEngine, sha256, EVMChainAdapter, MockChainAdapter, createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS, mintTokens, ethers, tmpdir, mkdtemp, readFile, readdir, rm, join, fileURLToPath, _wrapAgentPublisherForSeal, CapturingContextGraphChainAdapter, AsyncSignerAddressContextGraphChainAdapter, SignerListContextGraphChainAdapter, PcaCuratedRegistrationChainAdapter, NonRegisteringACKChainAdapter, FlakyRegistrationACKChainAdapter, TransientIdentityFailureChainAdapter, BrandNewCoreTransientChainAdapter, PermanentProfileFailureChainAdapter, RetryPathPermanentFailureChainAdapter, ContextAuthorizedPublisherChainAdapter, buildSnapshotFactQuads, ReferenceEvaluator, loadYaml, CCL_FACT_NS, OperationalKeyOnlyPublishChainAdapter, ExternalOperationalKeyPublishChainAdapter, AddressOnlyExternalOperationalKeyPublishChainAdapter, AsyncAddressSignMessageAsPublishChainAdapter, GenericSignMessageExternalOperationalKeyPublishChainAdapter, MultiSignerGenericSignMessagePublishChainAdapter, SingleAddressMismatchedGenericSignMessagePublishChainAdapter, SingleSignerAdapterPublishChainAdapter, ReservingAuthorityContextGraphChainAdapter, type Quad, type ChainAdapter, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type OnChainPublishResult, type V10PublishDirectParams } from './agent.shared';



let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('DKGAgent config — syncContextGraphs and queryAccess warning', () => {

    it('DKGAgentConfig accepts syncContextGraphs array', async () => {
      const agent = await DKGAgent.create({
        name: 'SyncConfigTest',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        syncContextGraphs: ['my-custom-contextGraph', 'another-contextGraph'],
      });
      expect(agent).toBeDefined();
      await agent.stop().catch(() => {});
    });


    it('adds runtime subscriptions to sync scope', async () => {
      const agent = await DKGAgent.create({
        name: 'RuntimeSyncScope',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      try {
        await agent.start();
        expect((agent as any).config.syncContextGraphs ?? []).not.toContain('runtime-contextGraph');

        agent.subscribeToContextGraph('runtime-contextGraph');

        expect((agent as any).config.syncContextGraphs ?? []).toContain('runtime-contextGraph');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('does not add discovery subscriptions to sync scope when tracking is disabled', async () => {
      const agent = await DKGAgent.create({
        name: 'RuntimeSyncScopeNoTrack',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      try {
        await agent.start();
        expect((agent as any).config.syncContextGraphs ?? []).not.toContain('discovered-contextGraph');

        agent.subscribeToContextGraph('discovered-contextGraph', { trackSyncScope: false });

        expect((agent as any).config.syncContextGraphs ?? []).not.toContain('discovered-contextGraph');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('persists runtime subscriptions and rehydrates them on restart', async () => {
      const persisted = new Map<string, any>();
      const persistedMembers = new Map<string, any>();
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => {
          persisted.set(record.id, { ...record });
        },
        delete: async (contextGraphId: string) => {
          persisted.delete(contextGraphId);
        },
      };
      const membershipStore = {
        upsert: async (record: any) => {
          persistedMembers.set(`${record.contextGraphId}|${record.principalType}|${record.principalId}`, { ...record });
        },
        delete: async (contextGraphId: string, principalType: string, principalId: string) => {
          persistedMembers.delete(`${contextGraphId}|${principalType}|${principalId}`);
        },
      };

      const agentA = await DKGAgent.create({
        name: 'PersistedSubscriptionsA',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });

      let agentAPeerId = '';
      try {
        await agentA.start();
        agentAPeerId = agentA.peerId;
        agentA.subscribeToContextGraph('persisted-cg');
        agentA.markContextGraphSubscriptionState('persisted-cg', {
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          onChainId: '0x1234',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        await agentA.stop().catch(() => {});
      }

      expect(persisted.get('persisted-cg')).toMatchObject({
        id: 'persisted-cg',
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
        onChainId: '0x1234',
        syncScoped: true,
      });
      expect(persistedMembers.get(`persisted-cg|node|${agentAPeerId}`)).toMatchObject({
        contextGraphId: 'persisted-cg',
        principalType: 'node',
        principalId: agentAPeerId,
        role: 'subscriber',
        status: 'active',
        source: 'subscription',
      });

      const agentB = await DKGAgent.create({
        name: 'PersistedSubscriptionsB',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });

      try {
        await agentB.start();
        expect(agentB.getSubscribedContextGraphs().get('persisted-cg')).toMatchObject({
          subscribed: true,
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
          onChainId: '0x1234',
        });
        expect((agentB as any).config.syncContextGraphs ?? []).toContain('persisted-cg');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(persistedMembers.get(`persisted-cg|node|${agentB.peerId}`)).toMatchObject({
          contextGraphId: 'persisted-cg',
          principalType: 'node',
          principalId: agentB.peerId,
          status: 'active',
          source: 'rehydrated-subscription',
        });
      } finally {
        await agentB.stop().catch(() => {});
      }
    });


    it('rehydrates persisted subscriptions without forcing sync scope', async () => {
      const subscriptionStore = {
        loadAll: async () => [{
          id: 'discovered-cg',
          name: 'Discovered CG',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          onChainId: '0xabcd',
          syncScoped: false,
        }],
        save: async () => {},
        delete: async () => {},
      };

      const agent = await DKGAgent.create({
        name: 'PersistedSubscriptionsNoScope',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });

      try {
        await agent.start();
        expect(agent.getSubscribedContextGraphs().get('discovered-cg')).toMatchObject({
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          onChainId: '0xabcd',
        });
        expect((agent as any).config.syncContextGraphs ?? []).not.toContain('discovered-cg');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('caps subscription activation at maxRehydratedContextGraphSubscriptions, leaving the rest dormant (#997)', async () => {
      const N = 10;
      const cap = 3;
      const rows = Array.from({ length: N }, (_, i) => ({
        id: `cap-cg-${i}`,
        name: `Cap CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async () => {},
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydration',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        maxRehydratedContextGraphSubscriptions: cap,
      });
      try {
        await agent.start();
        const subs = agent.getSubscribedContextGraphs();
        // Only `cap` of the N persisted rows are activated; the rest stay
        // persisted (loadAll still returns all N) but dormant in-memory.
        const activated = rows.filter((r) => subs.get(r.id)?.subscribed === true).length;
        expect(activated).toBe(cap);
        const inSyncScope = ((agent as any).config.syncContextGraphs ?? []).filter(
          (id: string) => id.startsWith('cap-cg-'),
        ).length;
        expect(inSyncScope).toBe(cap);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('exempts coreHosted graphs from the rehydration cap so hosted graphs always restore (#997)', async () => {
      const cap = 2;
      const mkRow = (id: string, coreHosted: boolean) => ({
        id, name: id, subscribed: true, synced: false,
        sharedMemorySynced: false, metaSynced: false, syncScoped: true, coreHosted,
      });
      const hosted = Array.from({ length: 3 }, (_, i) => mkRow(`hosted-cg-${i}`, true));
      const user = Array.from({ length: 5 }, (_, i) => mkRow(`user-cg-${i}`, false));
      const rows = [...hosted, ...user];
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async () => {},
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapHostedExempt',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        maxRehydratedContextGraphSubscriptions: cap,
      });
      try {
        await agent.start();
        const subs = agent.getSubscribedContextGraphs();
        // ALL coreHosted graphs activate (exempt from the cap — host-mode /
        // chain-reconcile depends on it); the non-hosted backlog stays capped.
        const hostedActive = hosted.filter((r) => subs.get(r.id)?.subscribed === true).length;
        const userActive = user.filter((r) => subs.get(r.id)?.subscribed === true).length;
        expect(hostedActive).toBe(hosted.length); // all 3 hosted restored despite cap=2
        expect(userActive).toBe(cap);              // user backlog capped at 2
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('clearContextGraphSubscriptions clears USER subscriptions but PRESERVES the system context graphs (#997)', async () => {
      const persisted = new Map<string, any>();
      for (let i = 0; i < 5; i++) {
        persisted.set(`clear-cg-${i}`, {
          id: `clear-cg-${i}`,
          name: `Clear ${i}`,
          subscribed: true,
          synced: false,
          syncScoped: true,
        });
      }
      // A coreHosted graph: a LEGITIMATE hosted graph, not part of the stale
      // backlog — the clear must preserve it (host-mode/reconcile depends on it),
      // exactly like the rehydration cap exempts it.
      persisted.set('hosted-cg', {
        id: 'hosted-cg',
        name: 'Hosted',
        subscribed: true,
        synced: false,
        syncScoped: true,
        coreHosted: true,
      });
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (r: any) => { persisted.set(r.id, { ...r }); },
        delete: async (id: string) => { persisted.delete(id); },
      };
      const agent = await DKGAgent.create({
        name: 'ClearSubscriptions',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      const systemIds = Object.values(SYSTEM_CONTEXT_GRAPHS) as string[];
      try {
        await agent.start();
        // start() rehydrates our 5 user CGs AND subscribes+persists the system CGs
        // (agents/ontology — the network control plane).
        expect([...persisted.keys()].filter((k) => k.startsWith('clear-cg-'))).toHaveLength(5);
        expect(agent.getSubscribedContextGraphs().get('clear-cg-0')?.subscribed).toBe(true);
        for (const sys of systemIds) {
          expect(agent.getSubscribedContextGraphs().get(sys)?.subscribed).toBe(true);
        }

        const cleared = await agent.clearContextGraphSubscriptions();

        // Exactly the 5 USER subscriptions are cleared — system CGs are never counted.
        expect(cleared).toBe(5);
        // No user row survives, live or persisted.
        expect([...persisted.keys()].some((k) => k.startsWith('clear-cg-'))).toBe(false);
        const userStillActive = ['clear-cg-0', 'clear-cg-1', 'clear-cg-2', 'clear-cg-3', 'clear-cg-4'].filter(
          (id) => agent.getSubscribedContextGraphs().get(id)?.subscribed === true,
        );
        expect(userStillActive).toHaveLength(0);

        // System context graphs are PRESERVED — live subscription intact AND the
        // persisted row kept — so the node never loses control-plane gossip.
        for (const sys of systemIds) {
          expect(agent.getSubscribedContextGraphs().get(sys)?.subscribed).toBe(true);
          expect(persisted.has(sys)).toBe(true);
        }

        // The coreHosted graph is PRESERVED too — NOT counted in `cleared`, still
        // subscribed, and its persisted row kept (the clear exempts hosted graphs
        // just like the rehydration cap, so host-mode/reconcile is never dropped).
        expect(agent.getSubscribedContextGraphs().get('hosted-cg')?.subscribed).toBe(true);
        expect(persisted.has('hosted-cg')).toBe(true);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('canonicalizes Ethereum agent membership principals before persistence', async () => {
      const persistedMembers = new Map<string, any>();
      const deletedMembers: string[] = [];
      const membershipStore = {
        upsert: async (record: any) => {
          persistedMembers.set(`${record.contextGraphId}|${record.principalType}|${record.principalId}`, { ...record });
        },
        delete: async (contextGraphId: string, principalType: string, principalId: string) => {
          const key = `${contextGraphId}|${principalType}|${principalId}`;
          deletedMembers.push(key);
          persistedMembers.delete(key);
        },
      };
      const lowercaseAddress = '0x86b8521581b87e21ebd730cbba110e1480454d6d';
      const checksumAddress = ethers.getAddress(lowercaseAddress);

      const agent = await DKGAgent.create({
        name: 'MembershipPrincipalCanonical',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphMembershipStore: membershipStore,
      });

      try {
        await agent.start();
        await agent.createContextGraph({
          id: 'membership-canonical-cg',
          name: 'Membership Canonical',
          accessPolicy: 1,
          allowedAgents: [lowercaseAddress],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(persistedMembers.get(`membership-canonical-cg|agent|${checksumAddress}`)).toMatchObject({
          contextGraphId: 'membership-canonical-cg',
          principalType: 'agent',
          principalId: checksumAddress,
          role: 'participant',
          status: 'active',
          source: 'allowed-agent',
        });
        expect(persistedMembers.has(`membership-canonical-cg|agent|${lowercaseAddress}`)).toBe(false);

        await agent.removeAgentFromContextGraph('membership-canonical-cg', lowercaseAddress);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(deletedMembers).toContain(`membership-canonical-cg|agent|${checksumAddress}`);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('syncContextGraphFromConnectedPeers returns empty stats without peers', async () => {
      const agent = await DKGAgent.create({
        name: 'RuntimeCatchupNoPeers',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      try {
        await agent.start();
        agent.subscribeToContextGraph('runtime-contextGraph');
        const result = await agent.syncContextGraphFromConnectedPeers('runtime-contextGraph', {
          includeSharedMemory: true,
        });

        expect(result.connectedPeers).toBe(0);
        expect(result.syncCapablePeers).toBe(0);
        expect(result.peersTried).toBe(0);
        expect(result.dataSynced).toBe(0);
        expect(result.sharedMemorySynced).toBe(0);
        expect(result.diagnostics.noProtocolPeers).toBe(0);
        expect(result.diagnostics.durable.emptyResponses).toBe(0);
        expect(result.diagnostics.sharedMemory.emptyResponses).toBe(0);
      } finally {
        await agent.stop().catch(() => {});
      }
    });
});
