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

describe('DKGAgent (integration)', () => {

    it('creates an agent with the facade API', async () => {
      const agent = await DKGAgent.create({
        name: 'TestAgent',
        framework: 'OpenClaw',
        skills: [
          {
            skillType: 'ImageAnalysis',
            pricePerCall: 1.0,
            handler: async () => ({ success: true, outputData: new Uint8Array([42]) }),
          },
        ],
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      expect(agent.wallet).toBeDefined();
      expect(agent.publisher).toBeDefined();
      expect(agent.queryEngine).toBeDefined();
      expect(agent.discovery).toBeDefined();
    });


    it('starts, publishes profile, discovers self, and stops', async () => {
      const agent = await DKGAgent.create({
        name: 'SelfDiscoverer',
        framework: 'DKG',
        listenPort: 0,
        skills: [
          {
            skillType: 'TextAnalysis',
            pricePerCall: 0.1,
            handler: async () => ({ success: true }),
          },
        ],
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      await agent.start();

      const result = await agent.publishProfile();
      expect(result.kaId).toBeDefined();
      expect(result.kaManifest.length).toBeGreaterThan(0);

      const agents = await agent.findAgents();
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(agents[0].name).toBe('SelfDiscoverer');

      const offerings = await agent.findSkills({ skillType: 'TextAnalysis' });
      expect(offerings.length).toBeGreaterThanOrEqual(1);

      await agent.stop();
    }, 10000);


    it('publishProfile advertises only public CGs in contextGraphsServed', async () => {
      // Privacy invariant: the agent profile is published into the public
      // `agents` system context graph, gossipped to every subscriber. Private
      // / curated CG IDs MUST NOT leak through `contextGraphsServed`. The
      // filter in `DKGAgent.publishProfile` consults `isPrivateContextGraph`
      // — the same predicate the responder uses to gate sync requests — so
      // discovery and access-control stay aligned.
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'PrivacyHost',
        framework: 'DKG',
        listenPort: 0,
        store,
        skills: [],
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      try {
        await agent.createContextGraph({
          id: 'public-research',
          name: 'Public Research',
        });
        await agent.createContextGraph({
          id: 'secret-ops',
          name: 'Secret Ops',
          accessPolicy: 1,
          allowedAgents: ['0x0000000000000000000000000000000000000001'],
        });

        await agent.publishProfile();

        const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
        const result = await store.query(
          `SELECT ?served WHERE { GRAPH <${agentsGraph}> { ?h <https://dkg.origintrail.io/skill#contextGraphsServed> ?served } }`,
        );
        expect(result.type).toBe('bindings');
        const served = result.type === 'bindings'
          ? (result.bindings.map(b => b['served']).filter(Boolean) as string[])
          : [];
        expect(served.length).toBeGreaterThan(0);
        const joined = served.join(',');
        expect(joined).toContain('public-research');
        expect(joined).not.toContain('secret-ops');
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 15000);


    it('publishProfile excludes discovery-only entries (subscribed=false)', async () => {
      // Codex review on PR #434 (round 2) flagged that the
      // `subscribed === true` filter in publishProfile had no regression
      // test, so the discovery-only leak could come back unnoticed. This
      // exercises the actual `discoverContextGraphsFromStore()` path:
      // we seed the local triple store with ontology triples for an OPEN
      // CG the agent didn't explicitly subscribe to, run discovery (which
      // adds the entry with subscribed=false because we don't auto-
      // subscribe public CGs), then publish the profile and assert the
      // discovered-only CG was filtered out of contextGraphsServed.
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'DiscoveryFilterHost',
        framework: 'DKG',
        listenPort: 0,
        store,
        skills: [],
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      try {
        await agent.createContextGraph({
          id: 'normal-public',
          name: 'Normal Public',
        });

        const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
        const discoveredUri = 'did:dkg:context-graph:discovered-only';
        const seedQuads: Quad[] = [
          { subject: discoveredUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
          { subject: discoveredUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Discovered Only"', graph: ontologyGraph },
        ];
        await store.insert(seedQuads);

        const newlyDiscovered = await agent.discoverContextGraphsFromStore();
        expect(newlyDiscovered).toBeGreaterThan(0);

        await agent.publishProfile();

        const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
        const result = await store.query(
          `SELECT ?served WHERE { GRAPH <${agentsGraph}> { ?h <https://dkg.origintrail.io/skill#contextGraphsServed> ?served } }`,
        );
        expect(result.type).toBe('bindings');
        const served = result.type === 'bindings'
          ? (result.bindings.map(b => b['served']).filter(Boolean) as string[])
          : [];
        const joined = served.join(',');
        expect(joined).toContain('normal-public');
        expect(joined).not.toContain('discovered-only');
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 15000);
});
