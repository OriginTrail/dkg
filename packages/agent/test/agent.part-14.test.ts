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

describe('Node Roles', () => {

    it('profile includes node role and ontology types', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmEdge',
        name: 'EdgeBot',
        nodeRole: 'edge',
        skills: [],
      });

      const types = quads
        .filter(q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
        .map(q => q.object);
      expect(types).toContain('https://dkg.network/ontology#Agent');
      expect(types).toContain('https://dkg.network/ontology#EdgeNode');

      const roles = quads.filter(q => q.predicate === 'https://dkg.network/ontology#nodeRole');
      expect(roles.length).toBe(1);
      expect(roles[0].object).toBe('"edge"');
    });


    it('core node profile uses CoreNode type', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmCore',
        name: 'CoreBot',
        nodeRole: 'core',
        skills: [],
      });

      const types = quads
        .filter(q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
        .map(q => q.object);
      expect(types).toContain('https://dkg.network/ontology#CoreNode');
    });


    it('profile includes PROV provenance activity', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmProv',
        name: 'ProvBot',
        skills: [],
      });

      const provTriples = quads.filter(q =>
        q.predicate === 'http://www.w3.org/ns/prov#wasGeneratedBy',
      );
      expect(provTriples.length).toBe(1);

      const activityUri = provTriples[0].object;
      const activityType = quads.find(
        q => q.subject === activityUri &&
          q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      );
      expect(activityType?.object).toBe('http://www.w3.org/ns/prov#Activity');
    });


    it('profile includes ERC-8004 capabilities for skills', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmSkills',
        name: 'SkillBot',
        skills: [{ skillType: 'ImageAnalysis' }],
      });

      const caps = quads.filter(q =>
        q.predicate === 'https://eips.ethereum.org/erc-8004#capabilities',
      );
      expect(caps.length).toBe(1);

      const capType = quads.find(
        q => q.subject === caps[0].object &&
          q.object === 'https://eips.ethereum.org/erc-8004#Capability',
      );
      expect(capType).toBeDefined();
    });
});
