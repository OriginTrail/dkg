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

describe('Discovery Client', () => {

    it('finds agents by querying local store', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const { quads } = buildAgentProfile({
        peerId: 'QmDiscoverable',
        name: 'DiscoverableBot',
        framework: 'ElizaOS',
        skills: [{ skillType: 'ImageAnalysis', pricePerCall: 1.0, currency: 'TRAC' }],
      });

      await store.insert(quads);

      const agents = await discovery.findAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('DiscoverableBot');
      expect(agents[0].peerId).toBe('QmDiscoverable');
    });


    it('finds skill offerings', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const { quads } = buildAgentProfile({
        peerId: 'QmSkilled',
        name: 'SkilledBot',
        skills: [
          { skillType: 'ImageAnalysis', pricePerCall: 0.5, currency: 'TRAC', successRate: 0.99 },
        ],
      });

      await store.insert(quads);

      const offerings = await discovery.findSkillOfferings({ skillType: 'ImageAnalysis' });
      expect(offerings).toHaveLength(1);
      expect(offerings[0].agentName).toBe('SkilledBot');
      expect(offerings[0].skillType).toBe('ImageAnalysis');
    });


    it('finds agent by peerId', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const { quads } = buildAgentProfile({
        peerId: 'QmFindMe',
        name: 'FindMeBot',
        skills: [],
      });

      await store.insert(quads);

      const agent = await discovery.findAgentByPeerId('QmFindMe');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('FindMeBot');

      const notFound = await discovery.findAgentByPeerId('QmNonExistent');
      expect(notFound).toBeNull();
    });


    it('returns relayAddress when present in profile', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const relayAddr = '/ip4/1.2.3.4/tcp/9090/p2p/QmRelay';
      const { quads } = buildAgentProfile({
        peerId: 'QmWithRelay',
        name: 'RelayBot',
        skills: [],
        relayAddress: relayAddr,
      });

      await store.insert(quads);

      const agents = await discovery.findAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].relayAddress).toBe(relayAddr);

      const byPeerId = await discovery.findAgentByPeerId('QmWithRelay');
      expect(byPeerId).not.toBeNull();
      expect(byPeerId!.relayAddress).toBe(relayAddr);

      // Agent without relayAddress should have undefined
      const store2 = new OxigraphStore();
      const engine2 = new DKGQueryEngine(store2);
      const discovery2 = new DiscoveryClient(engine2);
      const { quads: q2 } = buildAgentProfile({
        peerId: 'QmNoRelay',
        name: 'NoRelayBot',
        skills: [],
      });
      await store2.insert(q2);
      const agents2 = await discovery2.findAgents();
      expect(agents2[0].relayAddress).toBeUndefined();
    });


    it('returns agentAddress on findAgentByPeerId — keeps both discovery entrypoints in lockstep', async () => {
      // Regression test for the #700 phonebook bug: `findAgents()` selects
      // and returns `?agentAddress` (lines 71/78/92 of `discovery.ts`), but
      // `findAgentByPeerId()` did NOT — its scalar SELECT omitted the
      // column entirely. The asymmetry made
      // `DKGAgent.drainPendingSenderKeyForPeer` (`dkg-agent.ts:6094-6102`)
      // a permanent no-op in production: drain branches on
      // `profile?.agentAddress` and the field was always undefined.
      //
      // This test pins the symmetry — once the drain feature ships, both
      // entrypoints MUST resolve the same identity for the same peer.
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const agentAddress = '0xAbCdEf0123456789AbCdEf0123456789aBcDeF01';
      const { quads } = buildAgentProfile({
        peerId: 'QmAgentAddrPeer',
        name: 'AgentAddrBot',
        agentAddress,
        skills: [],
      });

      await store.insert(quads);

      // 1. `findAgents()` already returned `agentAddress` — pin it as a
      //    sanity reference for what the second entrypoint must match.
      const all = await discovery.findAgents();
      expect(all).toHaveLength(1);
      expect(all[0].agentAddress).toBe(agentAddress.toLowerCase());

      // 2. `findAgentByPeerId()` now also returns it — this is the
      //    assertion that pins the fix.
      const byPeerId = await discovery.findAgentByPeerId('QmAgentAddrPeer');
      expect(byPeerId).not.toBeNull();
      expect(byPeerId!.agentAddress).toBe(agentAddress.toLowerCase());

      // 3. And: an agent profile *without* `agentAddress` must still
      //    resolve, just with the field undefined — so legacy profiles
      //    from older nodes don't break discovery.
      const store2 = new OxigraphStore();
      const engine2 = new DKGQueryEngine(store2);
      const discovery2 = new DiscoveryClient(engine2);
      const { quads: q2 } = buildAgentProfile({
        peerId: 'QmNoAgentAddr',
        name: 'NoAgentAddrBot',
        skills: [],
      });
      await store2.insert(q2);
      const byPeerId2 = await discovery2.findAgentByPeerId('QmNoAgentAddr');
      expect(byPeerId2).not.toBeNull();
      expect(byPeerId2!.agentAddress).toBeUndefined();
    });


    it('filters agents by framework', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const { quads: q1 } = buildAgentProfile({
        peerId: 'QmOC', name: 'OCBot', framework: 'OpenClaw', skills: [],
      });
      const { quads: q2 } = buildAgentProfile({
        peerId: 'QmEL', name: 'ELBot', framework: 'ElizaOS', skills: [],
      });

      await store.insert([...q1, ...q2]);

      const ocAgents = await discovery.findAgents({ framework: 'OpenClaw' });
      expect(ocAgents).toHaveLength(1);
      expect(ocAgents[0].name).toBe('OCBot');
    });


    it('returns empty when no agents in store', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);
      const discovery = new DiscoveryClient(engine);

      const agents = await discovery.findAgents();
      expect(agents).toHaveLength(0);

      const offerings = await discovery.findSkillOfferings();
      expect(offerings).toHaveLength(0);
    });
});
