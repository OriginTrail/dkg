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
          syncMode: 'always-on',
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


    it('keeps on-demand subscriptions process-local until explicitly promoted', async () => {
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
        name: 'OnDemandSubscriptionLifetimeA',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });

      try {
        await agentA.start();
        agentA.subscribeToContextGraph('selected-cg', { syncMode: 'on-demand' });
        agentA.markContextGraphSubscriptionState('selected-cg', {
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        });
        (agentA as any).persistContextGraphSubscription('selected-cg');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(agentA.getSubscribedContextGraphs().get('selected-cg')).toMatchObject({
          subscribed: true,
          syncMode: 'on-demand',
          synced: true,
        });
        expect(persisted.has('selected-cg')).toBe(false);
        expect(persistedMembers.has(`selected-cg|node|${agentA.peerId}`)).toBe(false);
      } finally {
        await agentA.stop().catch(() => {});
      }

      const agentB = await DKGAgent.create({
        name: 'OnDemandSubscriptionLifetimeB',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });
      try {
        await agentB.start();
        expect(agentB.getSubscribedContextGraphs().get('selected-cg')).toBeUndefined();

        agentB.subscribeToContextGraph('selected-cg', { syncMode: 'on-demand' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(persistedMembers.has(`selected-cg|node|${agentB.peerId}`)).toBe(false);

        agentB.subscribeToContextGraph('selected-cg', { syncMode: 'always-on' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(persisted.get('selected-cg')).toMatchObject({
          id: 'selected-cg',
          subscribed: true,
          synced: false,
        });
        expect(agentB.getSubscribedContextGraphs().get('selected-cg')?.syncMode).toBe('always-on');
        expect(persistedMembers.get(`selected-cg|node|${agentB.peerId}`)).toMatchObject({
          contextGraphId: 'selected-cg',
          principalType: 'node',
          principalId: agentB.peerId,
          status: 'active',
          source: 'subscription',
        });

        // A later UI open is on-demand, but must not silently downgrade an
        // operator's explicit always-on choice.
        agentB.subscribeToContextGraph('selected-cg', { syncMode: 'on-demand' });
        expect(agentB.getSubscribedContextGraphs().get('selected-cg')?.syncMode).toBe('always-on');
      } finally {
        await agentB.stop().catch(() => {});
      }
    });


    it('promotes an existing on-demand selection when the node creates the graph', async () => {
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
      const contextGraphId = 'selected-then-created-cg';
      const agent = await DKGAgent.create({
        name: 'OnDemandCreatePromotion',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });

      try {
        await agent.start();
        agent.subscribeToContextGraph(contextGraphId, { syncMode: 'on-demand' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(persisted.has(contextGraphId)).toBe(false);

        await agent.createContextGraph({
          id: contextGraphId,
          name: 'Selected then created',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
          subscribed: true,
          syncMode: 'always-on',
          synced: true,
          metaSynced: true,
        });
        expect(persisted.get(contextGraphId)).toMatchObject({
          id: contextGraphId,
          subscribed: true,
          synced: true,
          metaSynced: true,
          syncScoped: true,
        });
        expect(persistedMembers.get(`${contextGraphId}|node|${agent.peerId}`)).toMatchObject({
          contextGraphId,
          principalType: 'node',
          principalId: agent.peerId,
          status: 'active',
          source: 'subscription',
        });
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('persists a Core hosting obligation without persisting its on-demand member intent', async () => {
      const persisted = new Map<string, any>();
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => {
          persisted.set(record.id, { ...record });
        },
        delete: async (contextGraphId: string) => {
          persisted.delete(contextGraphId);
        },
      };
      const localCgId = 'selected-hosted-cg';

      const agentA = await DKGAgent.create({
        name: 'OnDemandCoreHostA',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        nodeRole: 'core',
      });
      try {
        await agentA.start();
        agentA.subscribeToContextGraph(localCgId, { syncMode: 'on-demand' });
        agentA.markContextGraphSubscriptionState(localCgId, {
          synced: true,
          sharedMemorySynced: true,
          metaSynced: true,
        });
        (agentA as any).chain.getContextGraphAccessPolicy = async () => 0;
        (agentA as any).chain.isContextGraphActiveOnChain = async () => true;

        await (agentA as any).recordCoreHostedPublicCg('14', localCgId);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(agentA.getSubscribedContextGraphs().get(localCgId)).toMatchObject({
          subscribed: true,
          syncMode: 'on-demand',
          synced: true,
          coreHosted: true,
          onChainId: '14',
        });
        expect(persisted.get(localCgId)).toMatchObject({
          id: localCgId,
          subscribed: false,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          coreHosted: true,
          onChainId: '14',
          syncScoped: false,
        });
      } finally {
        await agentA.stop().catch(() => {});
      }

      const agentB = await DKGAgent.create({
        name: 'OnDemandCoreHostB',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        nodeRole: 'core',
      });
      try {
        await agentB.start();
        expect(agentB.getSubscribedContextGraphs().get(localCgId)).toMatchObject({
          subscribed: false,
          syncMode: 'always-on',
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          coreHosted: true,
          onChainId: '14',
        });
        expect((agentB as any).config.syncContextGraphs ?? []).not.toContain(localCgId);
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


    it('restores join-approved signer hints across restart, including capped dormant subscriptions', async () => {
      const localAgentAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
      const pendingId = 'approved-a-pending';
      const confirmedId = 'approved-b-confirmed';
      const dormantId = 'approved-z-dormant';
      const confirmedOnChainHash = ethers.keccak256(ethers.toUtf8Bytes(confirmedId));
      const subscriptionWrites: any[] = [];
      const subscriptionStore = {
        loadAll: async () => [
          // Reproduce the v10.0.6 poison: an unrelated empty peer promoted all
          // completion flags before the curator metadata arrived.
          { id: pendingId, subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true, syncScoped: true },
          { id: confirmedId, subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true, syncScoped: true },
          { id: dormantId, subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true },
        ],
        save: async (record: any) => { subscriptionWrites.push({ ...record }); },
        delete: async () => {},
      };
      const membershipStore = {
        loadAll: async () => [
          ...[pendingId, confirmedId, dormantId].map((contextGraphId, index) => ({
            contextGraphId,
            principalType: 'agent' as const,
            principalId: localAgentAddress,
            role: 'participant',
            status: 'active' as const,
            source: 'join-approved',
            metadata: { curatorPeerId: `12D3KooWRestartCurator${index}` },
            firstSeenAt: 100 + index,
            updatedAt: 200 + index,
          })),
          // A newer but non-local approval must not steer this node's signer.
          {
            contextGraphId: pendingId,
            principalType: 'agent' as const,
            principalId: ethers.Wallet.createRandom().address,
            role: 'participant',
            status: 'active' as const,
            source: 'join-approved',
            updatedAt: 999,
          },
          // Only explicit join-approved facts carry the bootstrap signer hint.
          {
            contextGraphId: pendingId,
            principalType: 'agent' as const,
            principalId: localAgentAddress,
            role: 'participant',
            status: 'active' as const,
            source: 'allowed-agent',
            updatedAt: 1_000,
          },
        ],
        upsert: async () => {},
        delete: async () => {},
      };

      const agent = await DKGAgent.create({
        name: 'ApprovedMembershipRestart',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
        maxRehydratedContextGraphSubscriptions: 2,
      });
      // Both active rows have complete private control-plane definitions, but
      // only the confirmed row currently authorizes this local agent. Definition
      // metadata alone must not make a stale join-approved row ready on restart.
      const pendingUri = contextGraphDataGraphUri(pendingId);
      const pendingMeta = contextGraphMetaUri(pendingId);
      const confirmedUri = contextGraphDataGraphUri(confirmedId);
      const confirmedMeta = contextGraphMetaUri(confirmedId);
      const confirmedDelegation =
        `did:dkg:agent-delegation:${confirmedId}:${localAgentAddress.toLowerCase()}`;
      await agent.store.insert([
        {
          subject: pendingUri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: pendingMeta,
        },
        {
          subject: pendingUri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: sparqlString('private'),
          graph: pendingMeta,
        },
        {
          subject: pendingUri,
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: 'did:dkg:agent:12D3KooWRestartCuratorCreator',
          graph: pendingMeta,
        },
        {
          subject: pendingUri,
          predicate: DKG_ONTOLOGY.DKG_CURATOR,
          object: `did:dkg:agent:${localAgentAddress}`,
          graph: pendingMeta,
        },
        {
          subject: confirmedUri,
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: sparqlString('private'),
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: 'did:dkg:agent:12D3KooWRestartCuratorCreator',
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: DKG_ONTOLOGY.DKG_CURATOR,
          object: `did:dkg:agent:${localAgentAddress}`,
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: sparqlString(localAgentAddress),
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
          object: sparqlString('106'),
          graph: confirmedMeta,
        },
        {
          subject: confirmedUri,
          predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`,
          object: sparqlString(confirmedOnChainHash),
          graph: confirmedMeta,
        },
        {
          subject: confirmedDelegation,
          predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
          object: sparqlString(localAgentAddress),
          graph: confirmedMeta,
        },
        {
          subject: confirmedDelegation,
          predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT,
          object: sparqlString(String(Date.now() - 1_000)),
          graph: confirmedMeta,
        },
        {
          subject: confirmedDelegation,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY,
          object: sparqlString(localAgentAddress),
          graph: confirmedMeta,
        },
      ]);

      try {
        await agent.start();
        expect(agent.getDefaultAgentAddress()?.toLowerCase()).toBe(localAgentAddress.toLowerCase());

        const approvedByCg = (agent as any).localApprovedAgentByCG as Map<string, string>;
        const preferredByCg = (agent as any).preferredSyncPeers as Map<string, string>;
        expect(approvedByCg.get(pendingId)).toBe(localAgentAddress.toLowerCase());
        expect(approvedByCg.get(confirmedId)).toBe(localAgentAddress.toLowerCase());
        expect(approvedByCg.get(dormantId)).toBe(localAgentAddress.toLowerCase());
        expect(preferredByCg.get(pendingId)).toBe('12D3KooWRestartCurator0');
        expect(preferredByCg.get(confirmedId)).toBe('12D3KooWRestartCurator1');
        expect(preferredByCg.get(dormantId)).toBe('12D3KooWRestartCurator2');

        expect(agent.getSubscribedContextGraphs().get(pendingId)).toMatchObject({
          subscribed: true,
          metaSynced: false,
          pendingMeta: true,
        });
        expect(agent.getSubscribedContextGraphs().get(confirmedId)).toMatchObject({
          subscribed: true,
          metaSynced: true,
          onChainId: '106',
          onChainHash: confirmedOnChainHash.toLowerCase(),
        });
        expect(agent.getSubscribedContextGraphs().get(confirmedId)?.pendingMeta).toBeUndefined();
        expect(subscriptionWrites.filter((row) => row.id === confirmedId).at(-1)).toMatchObject({
          id: confirmedId,
          subscribed: true,
          metaSynced: true,
          onChainId: '106',
          onChainHash: confirmedOnChainHash.toLowerCase(),
        });
        expect(agent.getSubscribedContextGraphs().get(dormantId)).toBeUndefined();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()?.dormantIds).toEqual([dormantId]);

        // Even while capped/dormant, explicit activation can immediately pick
        // the approved local signer without waiting for another join decision.
        expect((await (agent as any).findLocalAgentForContextGraph(dormantId))?.toLowerCase())
          .toBe(localAgentAddress.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('keeps subscription rehydration best-effort when membership loading fails', async () => {
      const contextGraphId = 'approved-membership-load-failure';
      const subscriptionStore = {
        loadAll: async () => [{
          id: contextGraphId,
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          syncScoped: true,
        }],
        save: async () => {},
        delete: async () => {},
      };
      const membershipStore = {
        loadAll: async () => { throw new Error('membership store unavailable'); },
        upsert: async () => {},
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'ApprovedMembershipLoadFailure',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        contextGraphMembershipStore: membershipStore,
      });

      try {
        await agent.start();
        expect(agent.getSubscribedContextGraphs().get(contextGraphId)).toMatchObject({
          subscribed: true,
          metaSynced: false,
        });
        expect(agent.getSubscribedContextGraphs().get(contextGraphId)?.pendingMeta).toBeUndefined();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 1,
          activated: 1,
          dormant: 0,
        });
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('default rehydration deterministically activates 64 of a large persisted backlog (#997/#1180)', async () => {
      const rows = Array.from({ length: 173 }, (_, i) => ({
        id: `cap-cg-${String(i).padStart(3, '0')}`,
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
      });
      try {
        await agent.start();
        const subs = agent.getSubscribedContextGraphs();
        // Only the default activation cap is wired into gossip/sync scope; the
        // rest stay persisted but dormant and are reported via diagnostics.
        const activated = rows.filter((r) => subs.get(r.id)?.subscribed === true).length;
        expect(activated).toBe(64);
        expect(subs.get('cap-cg-000')?.subscribed).toBe(true);
        expect(subs.get('cap-cg-063')?.subscribed).toBe(true);
        expect(subs.get('cap-cg-064')).toBeUndefined();
        expect(subs.get('cap-cg-172')).toBeUndefined();
        const inSyncScope = ((agent as any).config.syncContextGraphs ?? []).filter(
          (id: string) => id.startsWith('cap-cg-'),
        ).length;
        expect(inSyncScope).toBe(64);
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 173,
          systemExcluded: 0,
          hostedActivated: 0,
          hostedActivatedIds: [],
          activated: 64,
          dormant: 109,
          activationCap: 64,
          capDisabled: false,
          dormantIds: rows.slice(64).map((r) => r.id),
        });
        expect(await agent.clearContextGraphSubscriptions()).toBe(173);
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 0,
          hostedActivated: 0,
          hostedActivatedIds: [],
          activated: 0,
          dormant: 0,
          dormantIds: [],
        });
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('uses deterministic id ordering when a custom rehydration cap is configured', async () => {
      const rows = [
        { id: 'cap-cg-c', name: 'C', subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true },
        { id: 'cap-cg-b', name: 'B', subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true },
        { id: 'cap-cg-a', name: 'A', subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true },
        { id: 'cap-cg-d', name: 'D', subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false, syncScoped: true },
      ];
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async () => {},
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationOrdering',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        maxRehydratedContextGraphSubscriptions: 2,
      });
      try {
        await agent.start();
        const subs = agent.getSubscribedContextGraphs();
        expect(subs.get('cap-cg-a')?.subscribed).toBe(true);
        expect(subs.get('cap-cg-b')?.subscribed).toBe(true);
        expect(subs.get('cap-cg-c')).toBeUndefined();
        expect(subs.get('cap-cg-d')).toBeUndefined();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()?.dormantIds).toEqual([
          'cap-cg-c',
          'cap-cg-d',
        ]);
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('keeps rehydration diagnostics when a persisted subscription delete fails', async () => {
      const rows = Array.from({ length: 65 }, (_, i) => ({
        id: `failed-delete-cg-${String(i).padStart(3, '0')}`,
        name: `Failed Delete CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async () => {},
        delete: async () => {
          throw new Error('delete failed');
        },
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationDeleteFailure',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          activated: 64,
          dormant: 1,
        });
        agent.unsubscribeFromContextGraph('failed-delete-cg-000');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          activated: 64,
          dormant: 1,
        });
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('updates only the affected dormant rehydration diagnostic after a successful persisted write', async () => {
      const rows = Array.from({ length: 66 }, (_, i) => ({
        id: `one-write-cg-${String(i).padStart(3, '0')}`,
        name: `One Write CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const saved: any[] = [];
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async (record: any) => {
          saved.push(record);
        },
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationOneWrite',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        const beforeStatus = agent.getContextGraphSubscriptionRehydrationStatus();
        expect(beforeStatus).toMatchObject({
          activated: 64,
          dormant: 2,
          dormantIds: ['one-write-cg-064', 'one-write-cg-065'],
        });

        agent.setContextGraphSubscription('one-write-cg-064', {
          name: 'One Write CG 64',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(saved.map((r) => r.id)).toContain('one-write-cg-064');
        const afterStatus = agent.getContextGraphSubscriptionRehydrationStatus();
        expect(afterStatus).toMatchObject({
          persistedTotal: 66,
          activated: 65,
          dormant: 1,
          dormantIds: ['one-write-cg-065'],
        });
        expect(afterStatus?.completedAt).toBe(beforeStatus?.completedAt);
        expect(afterStatus?.updatedAt).toBeGreaterThanOrEqual(beforeStatus?.updatedAt ?? 0);
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('serializes a queued delete after an earlier same-context save', async () => {
      const rows = Array.from({ length: 65 }, (_, i) => ({
        id: `stale-write-cg-${String(i).padStart(3, '0')}`,
        name: `Stale Write CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const saveResolvers: Array<() => void> = [];
      const subscriptionStore = {
        loadAll: async () => rows,
        save: async () => new Promise<void>((resolve) => {
          saveResolvers.push(resolve);
        }),
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationStaleWrite',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 65,
          activated: 64,
          dormant: 1,
          dormantIds: ['stale-write-cg-064'],
        });
        const startupSaveCount = saveResolvers.length;

        agent.setContextGraphSubscription('stale-write-cg-064', {
          name: 'Stale Write CG 64',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        agent.setContextGraphSubscription('stale-write-cg-064', {
          name: 'Stale Write CG 64',
          subscribed: false,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 65,
          activated: 64,
          dormant: 1,
          dormantIds: ['stale-write-cg-064'],
        });
        expect(saveResolvers).toHaveLength(startupSaveCount + 1);
        saveResolvers[startupSaveCount]();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 64,
          activated: 64,
          dormant: 0,
          dormantIds: [],
        });
      } finally {
        for (const resolve of saveResolvers) resolve();
        await agent.stop().catch(() => {});
      }
    });

    it('serializes same-context persisted writes so the newest saved state wins', async () => {
      const rows = Array.from({ length: 64 }, (_, i) => ({
        id: `new-race-cg-${String(i).padStart(3, '0')}`,
        name: `New Race CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const persisted = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
      const saveResolvers: Array<{ id: string; resolve: () => void }> = [];
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => new Promise<void>((resolve) => {
          saveResolvers.push({
            id: record.id,
            resolve: () => {
              persisted.set(record.id, { ...record });
              resolve();
            },
          });
        }),
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationNewRace',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 64,
          activated: 64,
          dormant: 0,
          dormantIds: [],
        });
        const startupSaveCount = saveResolvers.length;

        agent.setContextGraphSubscription('new-race-created', {
          name: 'New Race Created',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        agent.setContextGraphSubscription('new-race-created', {
          name: 'New Race Created',
          subscribed: true,
          synced: true,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(saveResolvers.slice(startupSaveCount).map((entry) => entry.id)).toEqual([
          'new-race-created',
        ]);

        saveResolvers[startupSaveCount].resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(saveResolvers.slice(startupSaveCount).map((entry) => entry.id)).toEqual([
          'new-race-created',
          'new-race-created',
        ]);
        saveResolvers[startupSaveCount + 1].resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 65,
          activated: 65,
          dormant: 0,
          dormantIds: [],
        });
        expect(persisted.get('new-race-created')?.synced).toBe(true);
      } finally {
        for (const { resolve } of saveResolvers) resolve();
        await agent.stop().catch(() => {});
      }
    });

    it('keeps an older successful persistence when a queued newer write fails', async () => {
      const rows = Array.from({ length: 64 }, (_, i) => ({
        id: `fail-race-cg-${String(i).padStart(3, '0')}`,
        name: `Fail Race CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const persisted = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
      const saveResolvers: Array<{ id: string; resolve: () => void; reject: () => void }> = [];
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => new Promise<void>((resolve, reject) => {
          saveResolvers.push({
            id: record.id,
            resolve: () => {
              persisted.set(record.id, { ...record });
              resolve();
            },
            reject: () => reject(new Error('save failed')),
          });
        }),
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'CapRehydrationFailedLatestRace',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 64,
          activated: 64,
          dormant: 0,
          dormantIds: [],
        });
        const startupSaveCount = saveResolvers.length;

        agent.setContextGraphSubscription('fail-race-created', {
          name: 'Fail Race Created',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        agent.setContextGraphSubscription('fail-race-created', {
          name: 'Fail Race Created',
          subscribed: true,
          synced: true,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(saveResolvers.slice(startupSaveCount).map((entry) => entry.id)).toEqual([
          'fail-race-created',
        ]);

        saveResolvers[startupSaveCount].resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 65,
          activated: 65,
          dormant: 0,
          dormantIds: [],
        });
        expect(saveResolvers.slice(startupSaveCount).map((entry) => entry.id)).toEqual([
          'fail-race-created',
          'fail-race-created',
        ]);

        saveResolvers[startupSaveCount + 1].reject();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 65,
          activated: 65,
          dormant: 0,
          dormantIds: [],
        });
        expect(persisted.get('fail-race-created')?.synced).toBe(false);
      } finally {
        for (const { resolve } of saveResolvers) resolve();
        await agent.stop().catch(() => {});
      }
    });

    it('disables the rehydration activation cap when configured with zero', async () => {
      const rows = Array.from({ length: 70 }, (_, i) => ({
        id: `uncapped-cg-${String(i).padStart(3, '0')}`,
        name: `Uncapped CG ${i}`,
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
        name: 'CapRehydrationDisabled',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
        maxRehydratedContextGraphSubscriptions: 0,
      });
      try {
        await agent.start();
        const subs = agent.getSubscribedContextGraphs();
        expect(rows.filter((r) => subs.get(r.id)?.subscribed === true)).toHaveLength(rows.length);
        expect(((agent as any).config.syncContextGraphs ?? []).filter(
          (id: string) => id.startsWith('uncapped-cg-'),
        )).toHaveLength(rows.length);
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 70,
          activated: 70,
          dormant: 0,
          activationCap: 0,
          capDisabled: true,
          hostedActivatedIds: [],
          dormantIds: [],
        });
      } finally {
        await agent.stop().catch(() => {});
      }
    });

    it('rebuilds persisted onChainHash reverse lookup during rehydration', async () => {
      const wireId = `0x${'a'.repeat(64)}`;
      const subscriptionStore = {
        loadAll: async () => [{
          id: 'wire-restore-cg',
          name: 'Wire Restore',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
          onChainHash: wireId.toUpperCase(),
          syncScoped: true,
        }],
        save: async () => {},
        delete: async () => {},
      };
      const agent = await DKGAgent.create({
        name: 'WireIdRehydration',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getSubscribedContextGraphs().get('wire-restore-cg')?.onChainHash).toBe(wireId);
        expect((agent as any).wireIdToLocalCgId.get(wireId)).toBe('wire-restore-cg');
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
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: rows.length,
          hostedActivated: hosted.length,
          hostedActivatedIds: hosted.map((r) => r.id),
          activated: hosted.length + cap,
          dormant: user.length - cap,
          activationCap: cap,
        });
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
        delete: async (id: string) => {
          if (!persisted.has(id)) throw new Error(`missing ${id}`);
          persisted.delete(id);
        },
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
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 6,
          systemExcluded: 0,
          hostedActivated: 1,
          hostedActivatedIds: ['hosted-cg'],
          activated: 6,
          dormant: 0,
          dormantIds: [],
        });
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
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 1,
          systemExcluded: 0,
          hostedActivated: 1,
          hostedActivatedIds: ['hosted-cg'],
          activated: 1,
          dormant: 0,
          dormantIds: [],
        });
        for (const mapName of [
          'contextGraphSubscriptionPersistRevisions',
          'contextGraphSubscriptionPersistAppliedRevisions',
          'contextGraphSubscriptionPersistCanceledRevisions',
          'contextGraphSubscriptionPersistPendingRevisions',
          'contextGraphSubscriptionPersistChains',
        ]) {
          expect((agent as any)[mapName].has('clear-cg-0')).toBe(false);
        }
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('invalidates pending persisted callbacks before clearing subscriptions', async () => {
      const rows = Array.from({ length: 64 }, (_, i) => ({
        id: `preclear-cg-${String(i).padStart(3, '0')}`,
        name: `Preclear CG ${i}`,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }));
      const persisted = new Map<string, any>(rows.map((r) => [r.id, { ...r }]));
      const saveResolvers: Array<{ id: string; resolve: () => void }> = [];
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => new Promise<void>((resolve) => {
          saveResolvers.push({
            id: record.id,
            resolve: () => {
              persisted.set(record.id, { ...record });
              resolve();
            },
          });
        }),
        delete: async (id: string) => {
          if (!persisted.has(id)) throw new Error(`missing ${id}`);
          persisted.delete(id);
        },
      };
      const agent = await DKGAgent.create({
        name: 'ClearSubscriptionsPendingSave',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 64,
          activated: 64,
          dormant: 0,
          dormantIds: [],
        });
        const startupSaveCount = saveResolvers.length;

        agent.setContextGraphSubscription('preclear-created', {
          name: 'Preclear Created',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(saveResolvers.slice(startupSaveCount).map((entry) => entry.id)).toEqual([
          'preclear-created',
        ]);

        let clearSettled = false;
        const clearPromise = agent.clearContextGraphSubscriptions().then((cleared) => {
          clearSettled = true;
          return cleared;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(clearSettled).toBe(false);

        saveResolvers.find((entry) => entry.id === 'preclear-created')?.resolve();
        expect(await clearPromise).toBe(65);
        expect(agent.getSubscribedContextGraphs().get('preclear-created')).toBeUndefined();
        expect(persisted.has('preclear-created')).toBe(false);
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 0,
          activated: 0,
          dormant: 0,
          dormantIds: [],
        });
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 0,
          activated: 0,
          dormant: 0,
          dormantIds: [],
        });
        for (const mapName of [
          'contextGraphSubscriptionPersistRevisions',
          'contextGraphSubscriptionPersistAppliedRevisions',
          'contextGraphSubscriptionPersistCanceledRevisions',
          'contextGraphSubscriptionPersistPendingRevisions',
          'contextGraphSubscriptionPersistChains',
        ]) {
          expect((agent as any)[mapName].has('preclear-created')).toBe(false);
        }
      } finally {
        for (const { resolve } of saveResolvers) resolve();
        await agent.stop().catch(() => {});
      }
    });

    it('does not allocate subscription persist revision state without a subscription store', async () => {
      const agent = await DKGAgent.create({
        name: 'StorelessSubscriptionRevisionCleanup',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        agent.setContextGraphSubscription('storeless-transient', {
          name: 'Storeless Transient',
          subscribed: true,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        agent.persistContextGraphSubscriptionState('storeless-transient');
        agent.setContextGraphSubscription('storeless-transient', {
          name: 'Storeless Transient',
          subscribed: false,
          synced: false,
          sharedMemorySynced: false,
          metaSynced: false,
        });
        expect(await agent.clearContextGraphSubscriptions()).toBe(0);

        for (const mapName of [
          'contextGraphSubscriptionPersistRevisions',
          'contextGraphSubscriptionPersistAppliedRevisions',
          'contextGraphSubscriptionPersistCanceledRevisions',
          'contextGraphSubscriptionPersistPendingRevisions',
          'contextGraphSubscriptionPersistChains',
        ]) {
          expect((agent as any)[mapName].has('storeless-transient')).toBe(false);
        }
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('downgrades failed active deletes to dormant rehydration diagnostics during clear', async () => {
      const failedId = 'clear-fail-cg-0';
      const successId = 'clear-fail-cg-1';
      const persisted = new Map<string, any>([failedId, successId].map((id) => [id, {
        id,
        name: id,
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        syncScoped: true,
      }]));
      const subscriptionStore = {
        loadAll: async () => [...persisted.values()],
        save: async (record: any) => { persisted.set(record.id, { ...record }); },
        delete: async (id: string) => {
          if (id === failedId) throw new Error('delete failed');
          if (!persisted.has(id)) throw new Error(`missing ${id}`);
          persisted.delete(id);
        },
      };
      const agent = await DKGAgent.create({
        name: 'ClearSubscriptionsPartialFailure',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        contextGraphSubscriptionStore: subscriptionStore,
      });
      try {
        await agent.start();
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 2,
          activated: 2,
          dormant: 0,
          dormantIds: [],
        });

        expect(await agent.clearContextGraphSubscriptions()).toBe(1);
        expect(agent.getSubscribedContextGraphs().get(failedId)).toBeUndefined();
        expect(agent.getSubscribedContextGraphs().get(successId)).toBeUndefined();
        expect(persisted.has(failedId)).toBe(true);
        expect(persisted.has(successId)).toBe(false);
        expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          persistedTotal: 1,
          activated: 0,
          dormant: 1,
          dormantIds: [failedId],
        });
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
